import { AlipaySdk } from "alipay-sdk";
import type { OrderRecord } from "../shared/contracts";
import { getSecret } from "./config";
import { audit, getSetting, type AppDatabase } from "./db";
import { AppError } from "./errors";
import { getActiveOrders, recordAndMatchPayment, type AccountLogEvent } from "./orders";
import { parseMoneyToCents } from "./security";

export interface AccountLogPage {
  pageNo: number;
  pageSize: number;
  totalSize: number;
  traceId: string;
  details: Array<Record<string, unknown>>;
}

export interface AccountLogProvider {
  query(input: { startTime: string; endTime: string; pageNo: number; pageSize: number }): Promise<AccountLogPage>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export class OfficialAlipayProvider implements AccountLogProvider {
  constructor(private readonly database: AppDatabase) {}

  async query(input: { startTime: string; endTime: string; pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    const appId = getSetting(this.database, "alipay_app_id", "");
    const privateKey = getSecret(this.database, "alipay_private_key");
    const alipayPublicKey = getSetting(this.database, "alipay_public_key", "");
    if (!appId || !privateKey || !alipayPublicKey) {
      throw new AppError(503, "ALIPAY_NOT_CONFIGURED", "支付宝应用 ID、应用私钥或支付宝公钥尚未配置");
    }

    const sdk = new AlipaySdk({
      appId,
      privateKey,
      alipayPublicKey,
      signType: "RSA2",
      keyType: "PKCS8",
      endpoint: getSetting(this.database, "alipay_endpoint", "https://openapi.alipay.com"),
      timeout: 8_000,
      camelcase: false,
    });
    const result = await sdk.curl<Record<string, unknown>>(
      "GET",
      "/v3/alipay/data/bill/accountlog/query",
      {
        query: {
          start_time: input.startTime,
          end_time: input.endTime,
          page_no: input.pageNo,
          page_size: input.pageSize,
        },
        requestTimeout: 8_000,
      },
    );
    const data = asRecord(result.data);
    return {
      pageNo: Number(data.page_no ?? data.pageNo ?? input.pageNo),
      pageSize: Number(data.page_size ?? data.pageSize ?? input.pageSize),
      totalSize: Number(data.total_size ?? data.totalSize ?? 0),
      details: Array.isArray(data.detail_list) ? data.detail_list.map(asRecord) :
        Array.isArray(data.detailList) ? data.detailList.map(asRecord) : [],
      traceId: result.traceId,
    };
  }
}

export function parseAlipayTime(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return new Date(0).toISOString();
  if (/Z$|[+-]\d\d:\d\d$/.test(raw)) return new Date(raw).toISOString();
  return new Date(`${raw.replace(" ", "T")}+08:00`).toISOString();
}

function formatShanghai(value: Date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function normalizeEvent(detail: Record<string, unknown>): AccountLogEvent | null {
  const accountLogId = String(detail.account_log_id ?? detail.accountLogId ?? "").trim();
  if (!accountLogId) return null;
  let amountCents: number;
  try {
    amountCents = parseMoneyToCents(String(detail.trans_amount ?? detail.transAmount ?? "0").replace(/^-/, ""));
  } catch {
    return null;
  }
  return {
    accountLogId,
    occurredAt: parseAlipayTime(detail.trans_dt ?? detail.transDt),
    direction: String(detail.direction ?? ""),
    amountCents,
    alipayOrderNo: String(detail.alipay_order_no ?? detail.alipayOrderNo ?? ""),
    transMemo: String(detail.trans_memo ?? detail.transMemo ?? ""),
    otherAccount: String(detail.other_account ?? detail.otherAccount ?? ""),
    raw: detail,
  };
}

export interface ScanResult {
  status: "success" | "skipped";
  activeOrders: number;
  pages: number;
  records: number;
  matched: number;
  traceId: string;
}

export class PaymentScanner {
  private inFlight: Promise<ScanResult> | null = null;
  private lastCompletedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly provider: AccountLogProvider = new OfficialAlipayProvider(database),
  ) {}

  get lastScanAt() {
    return this.lastCompletedAt;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (getActiveOrders(this.database).length > 0 && Date.now() - this.lastCompletedAt >= 5_000) {
        void this.scanNow("scheduler").catch((error) => {
          console.error(JSON.stringify({ level: "error", event: "scan_failed", message: error instanceof Error ? error.message : String(error) }));
        });
      }
    }, 1_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async ensureFresh(order: OrderRecord) {
    if (!["pending", "expired"].includes(order.status) || Date.parse(order.monitor_until) <= Date.now()) return;
    if (Date.now() - this.lastCompletedAt < 5_000) return;
    await Promise.race([
      this.scanNow("order_query"),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  scanNow(reason = "manual") {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performScan(reason).finally(() => {
      this.lastCompletedAt = Date.now();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performScan(reason: string): Promise<ScanResult> {
    let candidates = getActiveOrders(this.database);
    const startedAt = new Date().toISOString();
    const run = this.database.query(`
      INSERT INTO scan_runs(started_at, status, active_orders) VALUES (?, 'running', ?) RETURNING id
    `).get(startedAt, candidates.length) as { id: number };

    if (candidates.length === 0) {
      const finishedAt = new Date().toISOString();
      this.database.query("UPDATE scan_runs SET status = 'skipped', finished_at = ? WHERE id = ?").run(finishedAt, run.id);
      return { status: "skipped", activeOrders: 0, pages: 0, records: 0, matched: 0, traceId: "" };
    }

    let pages = 0;
    let records = 0;
    let matched = 0;
    let traceId = "";
    try {
      const earliest = Math.min(...candidates.map((order) => Date.parse(order.created_at))) - 60_000;
      const startTime = formatShanghai(new Date(earliest));
      const endTime = formatShanghai(new Date());
      const pageSize = 2_000;
      let pageNo = 1;
      let totalSize = Number.POSITIVE_INFINITY;

      while ((pageNo - 1) * pageSize < totalSize) {
        const page = await this.provider.query({ startTime, endTime, pageNo, pageSize });
        pages += 1;
        totalSize = page.totalSize || page.details.length;
        traceId ||= page.traceId;
        records += page.details.length;

        const events = page.details
          .map(normalizeEvent)
          .filter((event): event is AccountLogEvent => Boolean(event))
          .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
        for (const event of events) {
          const result = recordAndMatchPayment(this.database, event, candidates);
          if (result.matched) {
            matched += 1;
            candidates = getActiveOrders(this.database);
            if (candidates.length === 0) break;
          }
        }
        if (candidates.length === 0 || page.details.length < pageSize) break;
        pageNo += 1;
      }

      const finishedAt = new Date().toISOString();
      this.database.query(`
        UPDATE scan_runs SET status = 'success', finished_at = ?, pages = ?, records = ?, matched = ?, trace_id = ? WHERE id = ?
      `).run(finishedAt, pages, records, matched, traceId || null, run.id);
      audit(this.database, "payment.scan", { details: { reason, pages, records, matched, traceId } });
      return { status: "success", activeOrders: candidates.length, pages, records, matched, traceId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.query(`
        UPDATE scan_runs SET status = 'error', finished_at = ?, pages = ?, records = ?, matched = ?, error = ?, trace_id = ? WHERE id = ?
      `).run(new Date().toISOString(), pages, records, matched, message.slice(0, 2_000), traceId || null, run.id);
      throw error;
    }
  }
}

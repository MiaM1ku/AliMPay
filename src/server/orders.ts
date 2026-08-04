import type { ApiVersion, CheckoutData, CollectionMode, OrderRecord, OrderStatus, TransferLinkLayer } from "../shared/contracts";
import { getSetting, type AppDatabase } from "./db";
import { AppError, assert } from "./errors";
import { centsToMoney, parseMoneyToCents, randomDigits, randomToken, validateCallbackUrl } from "./security";
import { getRuntimeEnv } from "./env";
import { getPaymentPollIntervalSeconds, getSecret } from "./config";

export interface CreateOrderInput {
  pid: string;
  apiVersion: ApiVersion;
  outTradeNo: string;
  name: string;
  money: string;
  notifyUrl: string;
  returnUrl?: string;
  param?: string;
  clientIp?: string;
  rawRequest?: Record<string, unknown>;
}

function utcAfter(milliseconds: number, from = Date.now()) {
  return new Date(from + milliseconds).toISOString();
}

export function createTradeNo(now = new Date()) {
  const base = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${base}${randomDigits(6)}`;
}

function normalizeInput(input: CreateOrderInput) {
  const outTradeNo = input.outTradeNo.trim();
  const name = input.name.trim();
  assert(/^[A-Za-z0-9._:-]{1,64}$/.test(outTradeNo), 400, "INVALID_OUT_TRADE_NO", "商户订单号须为 1–64 位字母、数字或 . _ : -");
  assert(name.length > 0 && Buffer.byteLength(name, "utf8") <= 127, 400, "INVALID_NAME", "商品名称不能为空且不能超过 127 字节");
  assert(input.notifyUrl?.length > 0, 400, "INVALID_NOTIFY_URL", "notify_url 不能为空");
  validateCallbackUrl(input.notifyUrl, getRuntimeEnv().allowPrivateCallbacks);
  if (input.returnUrl) validateCallbackUrl(input.returnUrl, getRuntimeEnv().allowPrivateCallbacks);
  return {
    ...input,
    outTradeNo,
    name,
    requestedAmountCents: parseMoneyToCents(input.money),
    notifyUrl: input.notifyUrl.trim(),
    returnUrl: input.returnUrl?.trim() || null,
    param: (input.param ?? "").slice(0, 1024),
    clientIp: (input.clientIp ?? "").slice(0, 128),
  };
}

function immutableOrderMatches(order: OrderRecord, input: ReturnType<typeof normalizeInput>) {
  return order.api_version === input.apiVersion &&
    order.name === input.name &&
    order.requested_amount_cents === input.requestedAmountCents &&
    order.notify_url === input.notifyUrl &&
    order.return_url === input.returnUrl &&
    order.param === input.param;
}

export function createOrder(database: AppDatabase, rawInput: CreateOrderInput): { order: OrderRecord; reused: boolean } {
  const input = normalizeInput(rawInput);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    expireOrders(database, now);
    database.query("DELETE FROM amount_reservations WHERE reserved_until <= ?").run(now);

    const duplicate = getOrderByMerchantNo(database, input.pid, input.outTradeNo);
    if (duplicate) {
      if (!immutableOrderMatches(duplicate, input)) {
        throw new AppError(409, "ORDER_CONFLICT", "相同商户订单号已存在，但金额、名称或回调地址不同");
      }
      database.exec("COMMIT");
      return { order: duplicate, reused: true };
    }

    const collectionMode = getSetting<CollectionMode>(database, "collection_mode", "business_qr");
    assert(
      getSetting(database, "alipay_app_id", "") && getSecret(database, "alipay_private_key") && getSetting(database, "alipay_public_key", ""),
      503,
      "ALIPAY_NOT_CONFIGURED",
      "支付宝 V3 应用凭据尚未配置完整",
    );
    if (collectionMode === "business_qr") {
      assert(getSetting(database, "business_qr_url", ""), 503, "BUSINESS_QR_MISSING", "经营码尚未上传");
    } else {
      assert(getSetting(database, "transfer_user_id", ""), 503, "TRANSFER_USER_MISSING", "转账模式尚未配置支付宝用户 ID");
    }

    let payableAmountCents = input.requestedAmountCents;
    if (collectionMode === "business_qr") {
      const maxOffset = Math.max(1, Math.min(99, getSetting(database, "surcharge_max_cents", 99)));
      let allocated = false;
      for (let offset = 1; offset <= maxOffset; offset += 1) {
        const candidate = input.requestedAmountCents + offset;
        const occupied = database.query("SELECT 1 FROM amount_reservations WHERE amount_cents = ? LIMIT 1").get(candidate);
        if (!occupied) {
          payableAmountCents = candidate;
          allocated = true;
          break;
        }
      }
      assert(allocated, 429, "AMOUNT_POOL_EXHAUSTED", "当前相同金额的待支付订单过多，请十分钟后重试");
    }

    const id = crypto.randomUUID();
    const tradeNo = createTradeNo();
    const checkoutToken = randomToken(24);
    const expiresAt = utcAfter(5 * 60_000, nowMs);
    const monitorUntil = utcAfter(10 * 60_000, nowMs);
    const rawRequest = { ...(input.rawRequest ?? {}) };
    delete rawRequest.sign;
    delete rawRequest.key;

    database.query(`
      INSERT INTO orders(
        id, trade_no, pid, api_version, out_trade_no, name,
        requested_amount_cents, payable_amount_cents, collection_mode,
        notify_url, return_url, param, client_ip, checkout_token,
        status, created_at, expires_at, monitor_until, raw_request_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      id, tradeNo, input.pid, input.apiVersion, input.outTradeNo, input.name,
      input.requestedAmountCents, payableAmountCents, collectionMode,
      input.notifyUrl, input.returnUrl, input.param, input.clientIp, checkoutToken,
      now, expiresAt, monitorUntil, JSON.stringify(rawRequest),
    );

    if (collectionMode === "business_qr") {
      database.query(`
        INSERT INTO amount_reservations(id, order_id, amount_cents, reserved_until, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), id, payableAmountCents, monitorUntil, now);
    }

    const order = getOrderById(database, id);
    if (!order) throw new Error("订单写入后无法读取");
    database.exec("COMMIT");
    return { order, reused: false };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function expireOrders(database: AppDatabase, now = new Date().toISOString()) {
  return database.query("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(now).changes;
}

export function getOrderById(database: AppDatabase, id: string) {
  return database.query("SELECT * FROM orders WHERE id = ?").get(id) as OrderRecord | null;
}

export function getOrderByTradeNo(database: AppDatabase, tradeNo: string) {
  expireOrders(database);
  return database.query("SELECT * FROM orders WHERE trade_no = ?").get(tradeNo) as OrderRecord | null;
}

export function getOrderByMerchantNo(database: AppDatabase, pid: string, outTradeNo: string) {
  return database.query("SELECT * FROM orders WHERE pid = ? AND out_trade_no = ?").get(pid, outTradeNo) as OrderRecord | null;
}

export function findOrder(database: AppDatabase, pid: string, selector: { tradeNo?: string; outTradeNo?: string }) {
  expireOrders(database);
  if (selector.tradeNo) {
    return database.query("SELECT * FROM orders WHERE pid = ? AND trade_no = ?").get(pid, selector.tradeNo) as OrderRecord | null;
  }
  if (selector.outTradeNo) return getOrderByMerchantNo(database, pid, selector.outTradeNo);
  return null;
}

export function getActiveOrders(database: AppDatabase, now = new Date().toISOString()) {
  expireOrders(database, now);
  return database.query(`
    SELECT * FROM orders
    WHERE status IN ('pending', 'expired') AND monitor_until > ?
    ORDER BY created_at ASC
  `).all(now) as OrderRecord[];
}

export function listOrders(database: AppDatabase, options: {
  status?: OrderStatus;
  externalPaid?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
  pid?: string;
} = {}) {
  expireOrders(database);
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (options.status) {
    where.push("status = ?");
    bindings.push(options.status);
  }
  if (options.externalPaid === true) where.push("status IN ('paid', 'late_paid')");
  if (options.externalPaid === false) where.push("status IN ('pending', 'expired')");
  if (options.pid) {
    where.push("pid = ?");
    bindings.push(options.pid);
  }
  if (options.query) {
    where.push("(trade_no LIKE ? OR out_trade_no LIKE ? OR name LIKE ?)");
    const like = `%${options.query.replace(/[%_]/g, "\\$&")}%`;
    bindings.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const offset = Math.max(0, options.offset ?? 0);
  const data = database.query(`SELECT * FROM orders ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...bindings, limit, offset) as OrderRecord[];
  const total = (database.query(`SELECT COUNT(*) AS count FROM orders ${clause}`).get(...bindings) as { count: number }).count;
  return { data, total, limit, offset };
}

export interface AccountLogEvent {
  accountLogId: string;
  occurredAt: string;
  direction: string;
  amountCents: number;
  alipayOrderNo: string;
  transMemo: string;
  otherAccount: string;
  raw: Record<string, unknown>;
}

export function recordAndMatchPayment(database: AppDatabase, event: AccountLogEvent, candidates: OrderRecord[]) {
  const receivedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.query("SELECT matched_order_id FROM payment_events WHERE account_log_id = ?").get(event.accountLogId) as { matched_order_id: string | null } | null;
    if (existing) {
      database.exec("COMMIT");
      return { matched: false, duplicate: true, orderId: existing.matched_order_id };
    }

    let matchedOrder: OrderRecord | undefined;
    if (event.direction === "收入") {
      matchedOrder = candidates.find((order) => {
        const occurred = Date.parse(event.occurredAt);
        const withinWindow = occurred >= Date.parse(order.created_at) - 60_000 && occurred <= Date.parse(order.monitor_until);
        if (!withinWindow || order.payable_amount_cents !== event.amountCents) return false;
        if (order.collection_mode === "transfer") return event.transMemo.trim() === order.out_trade_no;
        return true;
      });
    }

    database.query(`
      INSERT INTO payment_events(
        account_log_id, matched_order_id, occurred_at, received_at, direction,
        amount_cents, alipay_order_no, trans_memo, other_account, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.accountLogId, matchedOrder?.id ?? null, event.occurredAt, receivedAt, event.direction,
      event.amountCents, event.alipayOrderNo || null, event.transMemo || null,
      event.otherAccount || null, JSON.stringify(event.raw),
    );

    if (matchedOrder) {
      const current = getOrderById(database, matchedOrder.id);
      if (current && (current.status === "pending" || current.status === "expired") && Date.parse(event.occurredAt) <= Date.parse(current.monitor_until)) {
        const status: OrderStatus = Date.parse(event.occurredAt) <= Date.parse(current.expires_at) ? "paid" : "late_paid";
        database.query(`
          UPDATE orders SET status = ?, paid_at = ?, alipay_account_log_id = ?, alipay_order_no = ?, buyer = ?
          WHERE id = ? AND status IN ('pending', 'expired')
        `).run(status, event.occurredAt, event.accountLogId, event.alipayOrderNo || null, event.otherAccount, current.id);
        database.query(`
          INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, 10, ?, 0, ?, ?)
        `).run(crypto.randomUUID(), current.id, receivedAt, receivedAt, receivedAt);
      } else {
        matchedOrder = undefined;
      }
    }

    database.exec("COMMIT");
    return { matched: Boolean(matchedOrder), duplicate: false, orderId: matchedOrder?.id ?? null };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function externalStatus(status: OrderStatus) {
  return status === "paid" || status === "late_paid" ? 1 : 0;
}

export function formatApiDate(value: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function serializeOrder(order: OrderRecord) {
  return {
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    api_trade_no: order.alipay_order_no ?? "",
    type: "alipay",
    pid: Number(order.pid),
    addtime: formatApiDate(order.created_at),
    ...(order.paid_at ? { endtime: formatApiDate(order.paid_at) } : {}),
    name: order.name,
    money: centsToMoney(order.requested_amount_cents),
    status: externalStatus(order.status),
    param: order.param,
    buyer: order.buyer,
    clientip: order.client_ip,
  };
}

export function buildReturnParameters(order: OrderRecord) {
  return {
    pid: order.pid,
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    api_trade_no: order.alipay_order_no ?? "",
    type: "alipay",
    trade_status: "TRADE_SUCCESS",
    addtime: formatApiDate(order.created_at),
    endtime: formatApiDate(order.paid_at),
    name: order.name,
    money: centsToMoney(order.requested_amount_cents),
    param: order.param,
    buyer: order.buyer,
  };
}

export function createTransferUri(order: OrderRecord, userId: string, layer: TransferLinkLayer = 2) {
  const params = new URLSearchParams({
    appId: "09999988",
    actionType: "toAccount",
    goBack: "NO",
    amount: centsToMoney(order.payable_amount_cents),
    userId,
    memo: order.out_trade_no,
  });
  const firstLayer = `alipays://platformapi/startapp?${params.toString()}`;
  const secondLayer = `https://render.alipay.com/p/s/i?scheme=${encodeURIComponent(firstLayer)}`;
  const thirdLayer = `alipays://platformapi/startapp?${new URLSearchParams({
    appId: "20000218",
    url: secondLayer,
  }).toString()}`;

  return {
    1: firstLayer,
    2: secondLayer,
    3: thirdLayer,
  }[layer];
}

export function getCheckoutData(database: AppDatabase, token: string, signedReturnUrl?: string | null): CheckoutData | null {
  expireOrders(database);
  const order = database.query("SELECT * FROM orders WHERE checkout_token = ?").get(token) as OrderRecord | null;
  if (!order) return null;
  const businessQrUrl = getSetting(database, "business_qr_url", "");
  const transferUserId = getSetting(database, "transfer_user_id", "");
  const transferLinkLayer = getSetting<TransferLinkLayer>(database, "transfer_link_layer", 2);
  return {
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    name: order.name,
    requested_money: centsToMoney(order.requested_amount_cents),
    payable_money: centsToMoney(order.payable_amount_cents),
    collection_mode: order.collection_mode,
    status: order.status,
    created_at: order.created_at,
    expires_at: order.expires_at,
    monitor_until: order.monitor_until,
    payment_poll_interval_seconds: getPaymentPollIntervalSeconds(database),
    payment_uri: order.collection_mode === "transfer" ? createTransferUri(order, transferUserId, transferLinkLayer) : "",
    business_qr_url: businessQrUrl,
    return_url: order.return_url,
    return_target: signedReturnUrl ?? null,
  };
}

export function getOrderByCheckoutToken(database: AppDatabase, token: string) {
  expireOrders(database);
  return database.query("SELECT * FROM orders WHERE checkout_token = ?").get(token) as OrderRecord | null;
}

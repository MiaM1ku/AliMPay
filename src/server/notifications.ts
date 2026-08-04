import type { ApiVersion, OrderRecord } from "../shared/contracts";
import { getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { buildReturnParameters, getOrderById } from "./orders";
import { assertPublicDestination, md5Sign, rsaSign, validateCallbackUrl } from "./security";

interface NotificationJob {
  id: string;
  order_id: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  manual: number;
}

export function signPlatformParameters(
  database: AppDatabase,
  apiVersion: ApiVersion,
  payload: Record<string, unknown>,
) {
  if (apiVersion === "v1") {
    const key = getSecret(database, "v1_key");
    if (!key) throw new AppError(503, "V1_KEY_MISSING", "V1 MD5 密钥尚未配置");
    return { ...payload, sign: md5Sign(payload, key), sign_type: "MD5" };
  }
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const withTimestamp = { ...payload, timestamp };
  const privateKey = getSecret(database, "v2_platform_private_key");
  if (!privateKey) throw new AppError(503, "V2_KEY_MISSING", "V2 平台私钥尚未配置");
  return { ...withTimestamp, sign: rsaSign(withTimestamp, privateKey), sign_type: "RSA" };
}

function toSearchParams(parameters: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return search;
}

export function buildSignedCallbackUrl(database: AppDatabase, order: OrderRecord, baseUrl: string) {
  const signed = signPlatformParameters(database, order.api_version, buildReturnParameters(order));
  const url = new URL(baseUrl);
  const search = toSearchParams(signed);
  for (const [key, value] of search) url.searchParams.set(key, value);
  return url.toString();
}

export function buildSignedReturnUrl(database: AppDatabase, order: OrderRecord) {
  if (!order.return_url || (order.status !== "paid" && order.status !== "late_paid")) return null;
  return buildSignedCallbackUrl(database, order, order.return_url);
}

export function queueManualNotification(database: AppDatabase, orderId: string) {
  const order = getOrderById(database, orderId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
  if (order.status !== "paid" && order.status !== "late_paid") {
    throw new AppError(409, "ORDER_NOT_PAID", "只有已支付订单可以补发通知");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  database.query(`
    INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, 1, ?, 1, ?, ?)
  `).run(id, orderId, now, now, now);
  return id;
}

export class NotificationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private working = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const now = new Date().toISOString();
    this.database.query(`
      UPDATE notification_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'
    `).run(now, now);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      for (let count = 0; count < 10; count += 1) {
        const job = this.claimNext();
        if (!job) break;
        await this.deliver(job);
      }
    } finally {
      this.working = false;
    }
  }

  private claimNext() {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.database.query(`
        SELECT * FROM notification_jobs
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC LIMIT 1
      `).get(now) as NotificationJob | null;
      if (!job) {
        this.database.exec("COMMIT");
        return null;
      }
      const changed = this.database.query(`
        UPDATE notification_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'
      `).run(now, job.id).changes;
      this.database.exec("COMMIT");
      return changed ? job : null;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async deliver(job: NotificationJob) {
    const order = getOrderById(this.database, job.order_id);
    const attemptNumber = job.attempts + 1;
    const requestedAt = new Date().toISOString();
    const attempt = this.database.query(`
      INSERT INTO notification_attempts(job_id, attempt_number, requested_at) VALUES (?, ?, ?) RETURNING id
    `).get(job.id, attemptNumber, requestedAt) as { id: number };

    let responseStatus: number | null = null;
    let responseBody = "";
    let errorMessage = "";
    let acknowledged = false;
    try {
      if (!order) throw new Error("关联订单不存在");
      const target = validateCallbackUrl(order.notify_url, getRuntimeEnv().allowPrivateCallbacks);
      await assertPublicDestination(target, getRuntimeEnv().allowPrivateCallbacks);
      const signedUrl = buildSignedCallbackUrl(this.database, order, target.toString());
      const response = await this.fetcher(signedUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "AliMPay-Bun/1.0 notification",
          accept: "text/plain, */*;q=0.1",
        },
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = response.status;
      responseBody = (await response.text()).slice(0, 500);
      acknowledged = response.status >= 200 && response.status < 300 && responseBody.trim() === "success";
      if (!acknowledged) errorMessage = `商户未确认通知（HTTP ${response.status}）`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const completedAt = new Date().toISOString();
    this.database.query(`
      UPDATE notification_attempts SET completed_at = ?, response_status = ?, response_body = ?, error = ? WHERE id = ?
    `).run(completedAt, responseStatus, responseBody || null, errorMessage || null, attempt.id);

    if (acknowledged) {
      this.database.query(`
        UPDATE notification_jobs SET status = 'succeeded', attempts = ?, last_http_status = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(attemptNumber, responseStatus, completedAt, job.id);
      return;
    }

    const exhausted = attemptNumber >= job.max_attempts;
    const nextAttempt = new Date(Date.now() + 60_000).toISOString();
    this.database.query(`
      UPDATE notification_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_http_status = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(exhausted ? "failed" : "pending", attemptNumber, nextAttempt, responseStatus, errorMessage.slice(0, 1_000), completedAt, job.id);
  }
}

export function notificationHistory(database: AppDatabase, orderId: string) {
  const jobs = database.query(`
    SELECT * FROM notification_jobs WHERE order_id = ? ORDER BY created_at DESC
  `).all(orderId) as Array<Record<string, unknown>>;
  return jobs.map((job) => ({
    ...job,
    attempts_detail: database.query(`
      SELECT * FROM notification_attempts WHERE job_id = ? ORDER BY attempt_number ASC
    `).all(String(job.id)),
  }));
}

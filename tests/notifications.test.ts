import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AppDatabase } from "../src/server/db";
import { getSecret } from "../src/server/config";
import { NotificationWorker } from "../src/server/notifications";
import { createOrder } from "../src/server/orders";
import { rsaVerify, verifyMd5 } from "../src/server/security";
import { configuredDatabase, orderInput } from "./helpers";

let database: AppDatabase | undefined;
afterEach(() => database?.close());

function paidOrderAndJob(db: AppDatabase, apiVersion: "v1" | "v2" = "v1", maxAttempts = 10) {
  const order = createOrder(db, { ...orderInput(1), apiVersion }).order;
  const now = new Date().toISOString();
  db.query("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(now, order.id);
  const jobId = crypto.randomUUID();
  db.query(`
    INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, 0, ?, ?)
  `).run(jobId, order.id, maxAttempts, now, now, now);
  return { order, jobId };
}

describe("notification delivery", () => {
  it("sends a valid V1 callback immediately and accepts trimmed success", async () => {
    const configured = configuredDatabase();
    database = configured.database;
    const { jobId } = paidOrderAndJob(database);
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(verifyMd5(Object.fromEntries(url.searchParams), getSecret(database!, "v1_key"))).toBe(true);
      expect(url.searchParams.get("trade_status")).toBe("TRADE_SUCCESS");
      return new Response(" success\n", { status: 200 });
    }) as unknown as typeof fetch;
    await new NotificationWorker(database, fetcher).tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const job = database.query("SELECT status, attempts FROM notification_jobs WHERE id = ?").get(jobId) as { status: string; attempts: number };
    expect(job).toEqual({ status: "succeeded", attempts: 1 });
  });

  it("signs V2 callbacks with the platform key", async () => {
    const configured = configuredDatabase();
    database = configured.database;
    paidOrderAndJob(database, "v2");
    const fetcher = mock(async (input: string | URL | Request) => {
      const parameters = Object.fromEntries(new URL(String(input)).searchParams);
      expect(rsaVerify(parameters, configured.platform.publicKey)).toBe(true);
      expect(parameters.sign_type).toBe("RSA");
      return new Response("success", { status: 200 });
    }) as unknown as typeof fetch;
    await new NotificationWorker(database, fetcher).tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries exactly ten total attempts then fails", async () => {
    ({ database } = configuredDatabase());
    const { jobId } = paidOrderAndJob(database);
    const fetcher = mock(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const worker = new NotificationWorker(database, fetcher);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      database.query("UPDATE notification_jobs SET status = 'pending', next_attempt_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), jobId);
      await worker.tick();
    }
    const job = database.query("SELECT status, attempts FROM notification_jobs WHERE id = ?").get(jobId) as { status: string; attempts: number };
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(job).toEqual({ status: "failed", attempts: 10 });
  });

  it("recovers processing jobs after restart", () => {
    ({ database } = configuredDatabase());
    const { jobId } = paidOrderAndJob(database);
    database.query("UPDATE notification_jobs SET status = 'processing' WHERE id = ?").run(jobId);
    new NotificationWorker(database, mock() as unknown as typeof fetch);
    expect((database.query("SELECT status FROM notification_jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("pending");
  });
});

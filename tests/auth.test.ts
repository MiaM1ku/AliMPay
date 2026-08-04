import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import type { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { sha256 } from "../src/server/security";
import { configuredDatabase } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("admin session and CSRF", () => {
  it("requires authentication and a matching CSRF token and Origin", async () => {
    ({ database } = configuredDatabase());
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    database.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', 'unused', ?, ?)").run(userId, now, now);
    database.query(`
      INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, '', '')
    `).run(crypto.randomUUID(), userId, sha256("session-token"), new Date(Date.now() + 60_000).toISOString(), now, now);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const payload = JSON.stringify({ v1_enabled: false });
    expect((await app.request("http://localhost/admin-api/settings")).status).toBe(401);

    const baseHeaders = { cookie: "alimpay_session=session-token; alimpay_csrf=csrf-token", "content-type": "application/json" };
    expect((await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: baseHeaders, body: payload })).status).toBe(403);
    expect((await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "https://evil.example" }, body: payload })).status).toBe(403);
    const accepted = await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "http://localhost" }, body: payload });
    expect(accepted.status).toBe(200);
  });
});

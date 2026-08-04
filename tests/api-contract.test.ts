import { afterEach, describe, expect, it } from "bun:test";
import type { AccountLogPage, AccountLogProvider } from "../src/server/alipay";
import { PaymentScanner } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { md5Sign, rsaSign, rsaVerify } from "../src/server/security";
import { configuredDatabase } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(input: { pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: 0, details: [], traceId: "test" };
  }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

function form(parameters: Record<string, string>) {
  return new URLSearchParams(parameters).toString();
}

describe("EasyPay V1 contract", () => {
  it("creates idempotent orders and requires the key for queries", async () => {
    const configured = configuredDatabase("transfer");
    database = configured.database;
    setSetting(database, "transfer_link_layer", 2);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const unsigned = {
      pid: "1000000001", type: "alipay", out_trade_no: "V1-ORDER-1",
      notify_url: "https://merchant.example/notify", return_url: "https://merchant.example/return",
      name: "V1 product", money: "1.00", clientip: "203.0.113.10", sign_type: "MD5",
    };
    const signed = { ...unsigned, sign: md5Sign(unsigned, "1234567890abcdef1234567890abcdef") };
    const first = await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    expect(firstBody.code).toBe(1);
    expect(firstBody.qrcode).toMatch(/^https:\/\/render\.alipay\.com\/p\/s\/i\?scheme=/);
    const secondBody = await (await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) })).json() as Record<string, unknown>;
    expect(secondBody.trade_no).toBe(firstBody.trade_no);

    const denied = await app.request("http://localhost/api.php?act=order&pid=1000000001&out_trade_no=V1-ORDER-1");
    expect((await denied.json() as { code: number }).code).toBe(-1);
    const query = await app.request("http://localhost/api.php?act=order&pid=1000000001&key=1234567890abcdef1234567890abcdef&out_trade_no=V1-ORDER-1");
    const queryBody = await query.json() as Record<string, unknown>;
    expect(queryBody.code).toBe(1);
    expect(queryBody.status).toBe(0);
    expect(queryBody.out_trade_no).toBe("V1-ORDER-1");
  });
});

describe("EasyPay V2 contract", () => {
  it("verifies merchant requests and signs responses and errors", async () => {
    const configured = configuredDatabase("transfer");
    database = configured.database;
    setSetting(database, "transfer_link_layer", 2);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const unsigned = {
      pid: "1000000001", method: "web", type: "alipay", out_trade_no: "V2-ORDER-1",
      notify_url: "https://merchant.example/notify", return_url: "https://merchant.example/return",
      name: "V2 product", money: "2.00", clientip: "203.0.113.10",
      timestamp: String(Math.floor(Date.now() / 1_000)), sign_type: "RSA",
    };
    const signed = { ...unsigned, sign: rsaSign(unsigned, configured.merchant.privateKey) };
    const response = await app.request("http://localhost/api/pay/create", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) });
    const body = await response.json() as Record<string, string | number>;
    expect(body.code).toBe(0);
    expect(body.pay_type).toBe("qrcode");
    expect(body.pay_info).toMatch(/^https:\/\/render\.alipay\.com\/p\/s\/i\?scheme=/);
    expect(rsaVerify(body, configured.platform.publicKey)).toBe(true);

    const queryUnsigned = {
      pid: "1000000001",
      out_trade_no: "V2-ORDER-1",
      timestamp: String(Math.floor(Date.now() / 1_000)),
      sign_type: "RSA",
    };
    const queryResponse = await app.request("http://localhost/api/pay/query", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...queryUnsigned, sign: rsaSign(queryUnsigned, configured.merchant.privateKey) }),
    });
    const queryBody = await queryResponse.json() as Record<string, string | number>;
    expect(queryBody.code).toBe(0);
    expect(queryBody.status).toBe(0);
    expect(queryBody.out_trade_no).toBe("V2-ORDER-1");
    expect(rsaVerify(queryBody, configured.platform.publicKey)).toBe(true);

    const ordersUnsigned = {
      pid: "1000000001", offset: "0", limit: "50",
      timestamp: String(Math.floor(Date.now() / 1_000)), sign_type: "RSA",
    };
    const ordersResponse = await app.request("http://localhost/api/merchant/orders", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...ordersUnsigned, sign: rsaSign(ordersUnsigned, configured.merchant.privateKey) }),
    });
    const ordersBody = await ordersResponse.json() as Record<string, unknown>;
    expect(Array.isArray(ordersBody.data)).toBe(true);
    expect(rsaVerify(ordersBody, configured.platform.publicKey)).toBe(true);

    const expiredUnsigned = { pid: "1000000001", timestamp: String(Math.floor(Date.now() / 1_000) - 1_000), sign_type: "RSA" };
    const expired = { ...expiredUnsigned, sign: rsaSign(expiredUnsigned, configured.merchant.privateKey) };
    const failed = await app.request("http://localhost/api/merchant/info", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(expired) });
    const failedBody = await failed.json() as Record<string, string | number>;
    expect(failedBody.code).toBe(1);
    expect(rsaVerify(failedBody, configured.platform.publicKey)).toBe(true);
  });
});

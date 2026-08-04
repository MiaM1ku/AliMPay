import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import type { AppDatabase } from "../src/server/db";
import { createOrder, getOrderById } from "../src/server/orders";
import { configuredDatabase, orderInput } from "./helpers";

class FakeProvider implements AccountLogProvider {
  calls = 0;
  constructor(public details: Array<Record<string, unknown>> = [], private delay = 0) {}
  async query(input: { pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: this.details.length, traceId: "trace-test", details: this.details };
  }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("shared payment scanner", () => {
  it("makes zero upstream calls with no active order", async () => {
    ({ database } = configuredDatabase());
    const provider = new FakeProvider();
    const result = await new PaymentScanner(database, provider).scanNow();
    expect(result.status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });

  it("coalesces many orders into one query and stops after they are paid", async () => {
    ({ database } = configuredDatabase());
    const first = createOrder(database, orderInput(1)).order;
    const second = createOrder(database, orderInput(2)).order;
    const provider = new FakeProvider([
      { account_log_id: "A1", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: "1.01", alipay_order_no: "ALI1" },
      { account_log_id: "A2", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: "1.02", alipay_order_no: "ALI2" },
    ]);
    const scanner = new PaymentScanner(database, provider);
    const result = await scanner.scanNow();
    expect(provider.calls).toBe(1);
    expect(result.matched).toBe(2);
    expect(getOrderById(database, first.id)?.status).toBe("paid");
    expect(getOrderById(database, second.id)?.status).toBe("paid");
    expect((await scanner.scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(1);
  });

  it("coalesces concurrent refresh requests into one in-flight scan", async () => {
    ({ database } = configuredDatabase());
    createOrder(database, orderInput(1));
    const provider = new FakeProvider([], 20);
    const scanner = new PaymentScanner(database, provider);
    await Promise.all([scanner.scanNow("one"), scanner.scanNow("two"), scanner.scanNow("three")]);
    expect(provider.calls).toBe(1);
  });

  it("does not query after the 10-minute monitor deadline", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    database.query("UPDATE orders SET expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
      new Date(Date.now() - 6 * 60_000).toISOString(), new Date(Date.now() - 1).toISOString(), order.id,
    );
    const provider = new FakeProvider();
    expect((await new PaymentScanner(database, provider).scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });
});

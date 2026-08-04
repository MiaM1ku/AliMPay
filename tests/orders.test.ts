import { afterEach, describe, expect, it } from "bun:test";
import { setSetting, type AppDatabase } from "../src/server/db";
import {
  createTransferUri,
  createOrder,
  externalStatus,
  getActiveOrders,
  getCheckoutData,
  getOrderById,
  recordAndMatchPayment,
} from "../src/server/orders";
import { configuredDatabase, orderInput } from "./helpers";

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("order allocation and idempotency", () => {
  it("allocates unique cent amounts transactionally", () => {
    ({ database } = configuredDatabase());
    const orders = [1, 2, 3].map((index) => createOrder(database!, orderInput(index)).order);
    expect(orders.map((order) => order.payable_amount_cents)).toEqual([101, 102, 103]);
    expect(new Set(orders.map((order) => order.payable_amount_cents)).size).toBe(3);
  });

  it("returns an identical duplicate and rejects an immutable conflict", () => {
    ({ database } = configuredDatabase());
    const first = createOrder(database, orderInput(1));
    const duplicate = createOrder(database, orderInput(1));
    expect(duplicate.reused).toBe(true);
    expect(duplicate.order.id).toBe(first.order.id);
    expect(() => createOrder(database!, { ...orderInput(1), money: "2.00" })).toThrow(/已存在/);
  });
});

describe("payment state machine", () => {
  it("marks payments in minutes 5-10 as late_paid and deduplicates account logs", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    const now = new Date();
    database.query("UPDATE orders SET expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
      new Date(now.getTime() - 60_000).toISOString(),
      new Date(now.getTime() + 5 * 60_000).toISOString(),
      order.id,
    );
    const event = {
      accountLogId: "LOG-1",
      occurredAt: now.toISOString(),
      direction: "收入",
      amountCents: order.payable_amount_cents,
      alipayOrderNo: "ALI-1",
      transMemo: "",
      otherAccount: "buyer@example.com",
      raw: {},
    };
    const result = recordAndMatchPayment(database, event, getActiveOrders(database));
    expect(result.matched).toBe(true);
    expect(getOrderById(database, order.id)?.status).toBe("late_paid");
    expect(recordAndMatchPayment(database, event, getActiveOrders(database)).duplicate).toBe(true);
    expect((database.query("SELECT COUNT(*) AS count FROM notification_jobs").get() as { count: number }).count).toBe(1);
  });

  it("never matches outgoing events", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    const result = recordAndMatchPayment(database, {
      accountLogId: "OUT-1", occurredAt: new Date().toISOString(), direction: "支出",
      amountCents: order.payable_amount_cents, alipayOrderNo: "", transMemo: "", otherAccount: "", raw: {},
    }, [order]);
    expect(result.matched).toBe(false);
    expect(getOrderById(database, order.id)?.status).toBe("pending");
  });

  it("requires an exact memo in transfer compatibility mode", () => {
    ({ database } = configuredDatabase("transfer"));
    const order = createOrder(database, orderInput(1)).order;
    expect(order.payable_amount_cents).toBe(100);
    expect(createTransferUri(order, "2088000000000000", 1)).toContain("appId=09999988");
    expect(createTransferUri(order, "2088000000000000", 1)).toContain("memo=ORDER-1");
    const wrong = recordAndMatchPayment(database, {
      accountLogId: "MEMO-WRONG", occurredAt: new Date().toISOString(), direction: "收入",
      amountCents: 100, alipayOrderNo: "", transMemo: "OTHER", otherAccount: "", raw: {},
    }, [order]);
    expect(wrong.matched).toBe(false);
    const correct = recordAndMatchPayment(database, {
      accountLogId: "MEMO-CORRECT", occurredAt: new Date().toISOString(), direction: "收入",
      amountCents: 100, alipayOrderNo: "", transMemo: "ORDER-1", otherAccount: "", raw: {},
    }, [order]);
    expect(correct.matched).toBe(true);
  });

  it("generates every selectable transfer link layer", () => {
    ({ database } = configuredDatabase("transfer"));
    const order = createOrder(database, orderInput(1)).order;
    const layers = {
      1: createTransferUri(order, "2088000000000000", 1),
      2: createTransferUri(order, "2088000000000000", 2),
      3: createTransferUri(order, "2088000000000000", 3),
    };

    expect(new URL(layers[3]).searchParams.get("url")).toBe(layers[2]);
    expect(new URL(layers[2]).searchParams.get("scheme")).toBe(layers[1]);
    expect(createTransferUri(order, "2088000000000000")).toBe(layers[2]);
    expect(layers[2]).toStartWith("https://render.alipay.com/p/s/i?scheme=");
    expect(layers[1]).toContain("appId=09999988");
    expect(layers[1]).toContain("memo=ORDER-1");
  });

  it("returns the configured payment polling interval to checkout", () => {
    ({ database } = configuredDatabase("transfer"));
    setSetting(database, "payment_poll_interval_seconds", 12);
    const order = createOrder(database, orderInput(1)).order;
    expect(getCheckoutData(database, order.checkout_token)?.payment_poll_interval_seconds).toBe(12);
  });

  it("maps expired to unpaid and late paid to paid externally", () => {
    expect(externalStatus("pending")).toBe(0);
    expect(externalStatus("expired")).toBe(0);
    expect(externalStatus("paid")).toBe(1);
    expect(externalStatus("late_paid")).toBe(1);
  });
});

import { Hono, type Context } from "hono";
import type { OrderRecord, TransferLinkLayer } from "../shared/contracts";
import type { PaymentScanner } from "./alipay";
import { getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { AppError, assert } from "./errors";
import {
  createOrder,
  findOrder,
  getOrderById,
  listOrders,
  serializeOrder,
} from "./orders";
import { signPlatformParameters } from "./notifications";
import { centsToMoney, rsaVerify, secureEqual, verifyMd5 } from "./security";

type Parameters = Record<string, string>;

async function requestParameters(c: Context): Promise<Parameters> {
  const query = c.req.query();
  if (c.req.method === "GET") return query;
  const contentType = c.req.header("content-type") ?? "";
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  } else {
    body = await c.req.parseBody({ all: false }).catch(() => ({}));
  }
  const result: Parameters = { ...query };
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求处理失败";
}

function publicBaseUrl(database: AppDatabase) {
  return getSetting(database, "public_base_url", "").replace(/\/$/, "");
}

function checkoutUrl(database: AppDatabase, order: OrderRecord) {
  return `${publicBaseUrl(database)}/checkout/${encodeURIComponent(order.checkout_token)}`;
}

function checkMerchant(database: AppDatabase, pid: string) {
  const expected = getSetting(database, "merchant_pid", "");
  assert(expected && secureEqual(pid, expected), 401, "INVALID_MERCHANT", "商户 ID 错误");
}

function verifyV1(database: AppDatabase, parameters: Parameters) {
  assert(getSetting(database, "v1_enabled", true), 403, "V1_DISABLED", "V1 API 已关闭");
  checkMerchant(database, parameters.pid ?? "");
  assert((parameters.sign_type ?? "").toUpperCase() === "MD5", 401, "INVALID_SIGN_TYPE", "sign_type 必须为 MD5");
  const key = getSecret(database, "v1_key");
  assert(key && verifyMd5(parameters, key), 401, "INVALID_SIGNATURE", "MD5 签名校验失败");
}

function verifyV1Key(database: AppDatabase, parameters: Parameters) {
  assert(getSetting(database, "v1_enabled", true), 403, "V1_DISABLED", "V1 API 已关闭");
  checkMerchant(database, parameters.pid ?? "");
  const key = getSecret(database, "v1_key");
  assert(key && secureEqual(parameters.key ?? "", key), 401, "INVALID_KEY", "商户密钥错误");
}

function verifyV2(database: AppDatabase, parameters: Parameters) {
  assert(getSetting(database, "v2_enabled", true), 403, "V2_DISABLED", "V2 API 已关闭");
  checkMerchant(database, parameters.pid ?? "");
  assert((parameters.sign_type ?? "").toUpperCase() === "RSA", 401, "INVALID_SIGN_TYPE", "sign_type 必须为 RSA");
  assert(/^\d{10}$/.test(parameters.timestamp ?? ""), 401, "INVALID_TIMESTAMP", "timestamp 必须是 10 位秒级时间戳");
  const timestamp = Number(parameters.timestamp);
  assert(Math.abs(Math.floor(Date.now() / 1_000) - timestamp) <= 300, 401, "TIMESTAMP_EXPIRED", "timestamp 与服务器时间相差超过 300 秒");
  const merchantPublicKey = getSetting(database, "v2_merchant_public_key", "");
  assert(merchantPublicKey && rsaVerify(parameters, merchantPublicKey), 401, "INVALID_SIGNATURE", "RSA 签名校验失败");
}

function signedV2(database: AppDatabase, payload: Record<string, unknown>) {
  return signPlatformParameters(database, "v2", payload);
}

function v1Failure(c: Context, error: unknown) {
  return c.json({ code: -1, msg: errorMessage(error) });
}

function v2Failure(c: Context, database: AppDatabase, error: unknown) {
  const payload = { code: 1, msg: errorMessage(error) };
  try {
    return c.json(signedV2(database, payload));
  } catch {
    return c.json(payload);
  }
}

function requireOrderFields(parameters: Parameters, allowMissingReturn: boolean) {
  const type = parameters.type || "alipay";
  assert(type === "alipay", 400, "UNSUPPORTED_PAY_TYPE", "仅支持 type=alipay");
  assert(parameters.out_trade_no, 400, "MISSING_OUT_TRADE_NO", "out_trade_no 不能为空");
  assert(parameters.notify_url, 400, "MISSING_NOTIFY_URL", "notify_url 不能为空");
  if (!allowMissingReturn) assert(parameters.return_url, 400, "MISSING_RETURN_URL", "return_url 不能为空");
  assert(parameters.name, 400, "MISSING_NAME", "name 不能为空");
  assert(parameters.money, 400, "MISSING_MONEY", "money 不能为空");
}

function createFromParameters(database: AppDatabase, parameters: Parameters, apiVersion: "v1" | "v2", allowMissingReturn: boolean) {
  requireOrderFields(parameters, allowMissingReturn);
  return createOrder(database, {
    pid: parameters.pid!,
    apiVersion,
    outTradeNo: parameters.out_trade_no!,
    name: parameters.name!,
    money: parameters.money!,
    notifyUrl: parameters.notify_url!,
    returnUrl: parameters.return_url,
    param: parameters.param,
    clientIp: parameters.clientip,
    rawRequest: parameters,
  });
}

async function refreshedOrder(database: AppDatabase, scanner: PaymentScanner, parameters: Parameters) {
  const order = findOrder(database, parameters.pid ?? "", {
    tradeNo: parameters.trade_no,
    outTradeNo: parameters.out_trade_no,
  });
  if (order) {
    await scanner.ensureFresh(order).catch(() => undefined);
    return getOrderById(database, order.id);
  }
  return null;
}

function merchantStats(database: AppDatabase) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const todayIso = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`).toISOString();
  const yesterdayIso = new Date(Date.parse(todayIso) - 86_400_000).toISOString();
  const total = (database.query("SELECT COUNT(*) AS count FROM orders").get() as { count: number }).count;
  const today = database.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS cents
    FROM orders WHERE created_at >= ?
  `).get(todayIso) as { count: number; cents: number };
  const yesterday = database.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS cents
    FROM orders WHERE created_at >= ? AND created_at < ?
  `).get(yesterdayIso, todayIso) as { count: number; cents: number };
  return { total, today, yesterday };
}

export function createEasyPayRoutes(database: AppDatabase, scanner: PaymentScanner) {
  const app = new Hono();

  app.on(["GET", "POST"], "/submit.php", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV1(database, parameters);
      const { order } = createFromParameters(database, parameters, "v1", false);
      return c.redirect(checkoutUrl(database, order), 302);
    } catch (error) {
      return v1Failure(c, error);
    }
  });

  app.post("/mapi.php", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV1(database, parameters);
      assert(parameters.clientip, 400, "MISSING_CLIENT_IP", "clientip 不能为空");
      const { order } = createFromParameters(database, parameters, "v1", true);
      const result: Record<string, unknown> = { code: 1, msg: "success", trade_no: order.trade_no };
      if (order.collection_mode === "business_qr") result.payurl = checkoutUrl(database, order);
      else {
        const { createTransferUri } = await import("./orders");
        result.qrcode = createTransferUri(
          order,
          getSetting(database, "transfer_user_id", ""),
          getSetting<TransferLinkLayer>(database, "transfer_link_layer", 5),
        );
      }
      return c.json(result);
    } catch (error) {
      return v1Failure(c, error);
    }
  });

  app.on(["GET", "POST"], "/api.php", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV1Key(database, parameters);
      const act = parameters.act;
      if (act === "query") {
        const stats = merchantStats(database);
        return c.json({
          code: 1,
          pid: Number(parameters.pid),
          key: getSecret(database, "v1_key"),
          active: 1,
          money: "0.00",
          type: 0,
          account: "",
          username: "admin",
          orders: stats.total,
          order_today: stats.today.count,
          order_lastday: stats.yesterday.count,
        });
      }
      if (act === "order") {
        assert(parameters.trade_no || parameters.out_trade_no, 400, "MISSING_ORDER_SELECTOR", "trade_no 与 out_trade_no 至少填写一个");
        const order = await refreshedOrder(database, scanner, parameters);
        assert(order, 404, "ORDER_NOT_FOUND", "订单不存在");
        return c.json({ code: 1, msg: "查询订单号成功！", ...serializeOrder(order) });
      }
      if (act === "orders") {
        const limit = Math.min(50, Math.max(1, Number(parameters.limit || 20)));
        const page = Math.max(1, Number(parameters.page || 1));
        const result = listOrders(database, { pid: parameters.pid, limit, offset: (page - 1) * limit });
        return c.json({ code: 1, msg: "查询订单列表成功！", data: result.data.map(serializeOrder) });
      }
      throw new AppError(400, "UNSUPPORTED_ACTION", "不支持的 act，仅支持 query、order、orders");
    } catch (error) {
      return v1Failure(c, error);
    }
  });

  app.on(["GET", "POST"], "/api/pay/submit", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV2(database, parameters);
      const { order } = createFromParameters(database, parameters, "v2", true);
      return c.redirect(checkoutUrl(database, order), 302);
    } catch (error) {
      return v2Failure(c, database, error);
    }
  });

  app.post("/api/pay/create", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV2(database, parameters);
      assert(["web", "jump"].includes(parameters.method ?? ""), 400, "UNSUPPORTED_METHOD", "仅支持 method=web 或 jump");
      assert(parameters.clientip, 400, "MISSING_CLIENT_IP", "clientip 不能为空");
      const { order } = createFromParameters(database, parameters, "v2", true);
      let payType = "jump";
      let payInfo = checkoutUrl(database, order);
      if (order.collection_mode === "transfer") {
        const { createTransferUri } = await import("./orders");
        payType = "qrcode";
        payInfo = createTransferUri(
          order,
          getSetting(database, "transfer_user_id", ""),
          getSetting<TransferLinkLayer>(database, "transfer_link_layer", 5),
        );
      }
      return c.json(signedV2(database, {
        code: 0,
        msg: "success",
        trade_no: order.trade_no,
        pay_type: payType,
        pay_info: payInfo,
      }));
    } catch (error) {
      return v2Failure(c, database, error);
    }
  });

  app.post("/api/pay/query", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV2(database, parameters);
      assert(parameters.trade_no || parameters.out_trade_no, 400, "MISSING_ORDER_SELECTOR", "trade_no 与 out_trade_no 至少填写一个");
      const order = await refreshedOrder(database, scanner, parameters);
      assert(order, 404, "ORDER_NOT_FOUND", "订单不存在");
      return c.json(signedV2(database, { code: 0, msg: "success", ...serializeOrder(order) }));
    } catch (error) {
      return v2Failure(c, database, error);
    }
  });

  app.post("/api/merchant/info", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV2(database, parameters);
      const stats = merchantStats(database);
      return c.json(signedV2(database, {
        code: 0,
        msg: "success",
        pid: Number(parameters.pid),
        status: 1,
        pay_status: 1,
        settle_status: 0,
        money: "0.00",
        settle_type: 0,
        settle_account: "",
        settle_name: "",
        order_num: stats.total,
        order_num_today: stats.today.count,
        order_num_lastday: stats.yesterday.count,
        order_money_today: centsToMoney(stats.today.cents),
        order_money_lastday: centsToMoney(stats.yesterday.cents),
      }));
    } catch (error) {
      return v2Failure(c, database, error);
    }
  });

  app.post("/api/merchant/orders", async (c) => {
    try {
      const parameters = await requestParameters(c);
      verifyV2(database, parameters);
      const limit = Math.min(50, Math.max(1, Number(parameters.limit || 50)));
      const offset = Math.max(0, Number(parameters.offset || 0));
      const externalPaid = parameters.status === "1" ? true : parameters.status === "0" ? false : undefined;
      const result = listOrders(database, { pid: parameters.pid, limit, offset, externalPaid });
      return c.json(signedV2(database, { code: 0, msg: "success", data: result.data.map(serializeOrder) }));
    } catch (error) {
      return v2Failure(c, database, error);
    }
  });

  return app;
}

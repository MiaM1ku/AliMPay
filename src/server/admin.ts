import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { OrderStatus } from "../shared/contracts";
import { OfficialAlipayProvider, type PaymentScanner } from "./alipay";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  assertOriginAllowed,
  authMiddleware,
  checkLoginRateLimit,
  clearAuthCookies,
  clearLoginFailures,
  clientIp,
  createPasswordHash,
  createSession,
  recordLoginFailure,
  setAuthCookies,
  setupCompleted,
  verifyPassword,
  type AuthVariables,
} from "./auth";
import { getPublicSettings, getSecret, isGatewayReady, setSecret } from "./config";
import { audit, getSetting, setSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError, assert } from "./errors";
import { notificationHistory, queueManualNotification } from "./notifications";
import { getOrderById, listOrders } from "./orders";
import {
  generateRsaKeyPair,
  randomAlphaNumeric,
  randomMerchantPid,
  sha256,
  validatePrivateKey,
  validatePublicKey,
  toPkcs8PrivateKey,
  toSpkiPublicKey,
} from "./security";

const setupSchema = z.object({
  password: z.string().min(12, "密码至少 12 位").max(128),
  public_base_url: z.string().min(1),
});

const loginSchema = z.object({
  username: z.string().default("admin"),
  password: z.string().min(1).max(128),
});

function validatePublicBaseUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, "INVALID_PUBLIC_URL", "公开地址必须是无账号信息的 HTTP/HTTPS URL");
  }
  return url.toString().replace(/\/$/, "");
}

function taipeiMidnight(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() - daysAgo * 86_400_000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`).toISOString();
}

function shanghaiTime(value: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function imageType(buffer: Uint8Array) {
  if (buffer.length >= 8 && Buffer.from(buffer.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 12 && Buffer.from(buffer.subarray(0, 4)).toString() === "RIFF" && Buffer.from(buffer.subarray(8, 12)).toString() === "WEBP") return { ext: "webp", mime: "image/webp" };
  throw new AppError(400, "INVALID_QR_IMAGE", "仅支持真实的 PNG、JPEG 或 WebP 图片");
}

export function createAdminRoutes(database: AppDatabase, scanner: PaymentScanner) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/setup/status", (c) => c.json({ setup_completed: setupCompleted(database) }));

  app.post("/setup", async (c) => {
    assertOriginAllowed(c.req.url, c.req.header("origin"), database);
    assert(!setupCompleted(database), 409, "ALREADY_CONFIGURED", "系统已经完成初始化");
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "INVALID_SETUP", parsed.error.issues[0]?.message ?? "初始化参数错误");
    const publicBase = validatePublicBaseUrl(parsed.data.public_base_url);
    const passwordHash = await createPasswordHash(parsed.data.password);
    const platformPair = generateRsaKeyPair();
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      assert(!database.query("SELECT 1 FROM admin_users LIMIT 1").get(), 409, "ALREADY_CONFIGURED", "管理员已经存在");
      database.query(`
        INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)
      `).run(userId, passwordHash, now, now);
      setSetting(database, "public_base_url", publicBase);
      setSetting(database, "merchant_pid", randomMerchantPid());
      setSecret(database, "v1_key", randomAlphaNumeric(32));
      setSecret(database, "v2_platform_private_key", platformPair.privateKey);
      setSetting(database, "v2_platform_public_key", platformPair.publicKey);
      setSetting(database, "setup_completed", true);
      audit(database, "system.setup", { actor: "admin", ip: clientIp(c.req.raw.headers) });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const session = createSession(database, userId, c.req.raw.headers);
    setAuthCookies(c, session);
    return c.json({ ok: true, username: "admin" }, 201);
  });

  app.post("/login", async (c) => {
    assertOriginAllowed(c.req.url, c.req.header("origin"), database);
    assert(setupCompleted(database), 409, "SETUP_REQUIRED", "请先完成首次配置");
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "INVALID_LOGIN", "用户名或密码格式错误");
    const rateKey = `${clientIp(c.req.raw.headers)}:${parsed.data.username}`;
    checkLoginRateLimit(rateKey);
    const user = database.query("SELECT * FROM admin_users WHERE username = ?").get(parsed.data.username) as {
      id: string;
      username: string;
      password_hash: string;
    } | null;
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      recordLoginFailure(rateKey);
      audit(database, "auth.login_failed", { actor: parsed.data.username, ip: clientIp(c.req.raw.headers) });
      throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }
    clearLoginFailures(rateKey);
    database.query("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    const session = createSession(database, user.id, c.req.raw.headers);
    setAuthCookies(c, session);
    audit(database, "auth.login", { actor: user.username, ip: clientIp(c.req.raw.headers) });
    return c.json({ ok: true, username: user.username });
  });

  app.use("*", authMiddleware(database));

  app.get("/me", (c) => c.json({ user: c.get("admin"), csrf: Boolean(getCookie(c, CSRF_COOKIE)) }));

  app.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) database.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    clearAuthCookies(c);
    return c.json({ ok: true });
  });

  app.get("/dashboard", (c) => {
    const today = taipeiMidnight();
    const totals = database.query(`
      SELECT
        COUNT(*) AS today_order_count,
        SUM(CASE WHEN status IN ('paid','late_paid') THEN 1 ELSE 0 END) AS today_paid_count,
        COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS today_paid_cents
      FROM orders WHERE created_at >= ?
    `).get(today) as { today_order_count: number; today_paid_count: number; today_paid_cents: number };
    const statuses = database.query(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'late_paid' THEN 1 ELSE 0 END) AS late_paid_count,
        SUM(CASE WHEN status IN ('pending','expired') AND monitor_until > ? THEN 1 ELSE 0 END) AS active_monitors
      FROM orders
    `).get(new Date().toISOString()) as { pending_count: number; late_paid_count: number; active_monitors: number };
    const notifyFailed = (database.query("SELECT COUNT(*) AS count FROM notification_jobs WHERE status = 'failed'").get() as { count: number }).count;
    const lastScan = database.query("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get();
    const recentOrders = listOrders(database, { limit: 8 }).data;
    return c.json({
      ...totals,
      pending_count: statuses.pending_count ?? 0,
      late_paid_count: statuses.late_paid_count ?? 0,
      active_monitors: statuses.active_monitors ?? 0,
      notify_failed_count: notifyFailed,
      last_scan: lastScan,
      recent_orders: recentOrders,
      configured: isGatewayReady(database),
      collection_mode: getSetting(database, "collection_mode", "business_qr"),
    });
  });

  app.get("/orders", (c) => {
    const status = c.req.query("status") as OrderStatus | undefined;
    if (status && !["pending", "expired", "paid", "late_paid"].includes(status)) {
      throw new AppError(400, "INVALID_STATUS", "订单状态筛选值无效");
    }
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
    const result = listOrders(database, {
      status,
      query: c.req.query("q")?.trim(),
      limit,
      offset: (page - 1) * limit,
    });
    return c.json({ ...result, page });
  });

  app.get("/orders/:id", (c) => {
    const order = getOrderById(database, c.req.param("id"));
    assert(order, 404, "ORDER_NOT_FOUND", "订单不存在");
    const events = database.query("SELECT * FROM payment_events WHERE matched_order_id = ? ORDER BY id DESC").all(order.id);
    return c.json({ order, payment_events: events, notifications: notificationHistory(database, order.id) });
  });

  app.post("/orders/:id/resend", (c) => {
    const id = queueManualNotification(database, c.req.param("id"));
    audit(database, "notification.manual_queue", {
      actor: c.get("admin").username,
      targetType: "order",
      targetId: c.req.param("id"),
      ip: clientIp(c.req.raw.headers),
    });
    return c.json({ ok: true, job_id: id }, 202);
  });

  app.post("/scans/run", async (c) => {
    const result = await scanner.scanNow("admin");
    return c.json(result);
  });

  app.get("/scans", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30)));
    return c.json({ data: database.query("SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?").all(limit) });
  });

  app.get("/settings", (c) => c.json({
    ...getPublicSettings(database),
    transfer_user_id: getSetting(database, "transfer_user_id", ""),
    alipay_public_key: getSetting(database, "alipay_public_key", ""),
    alipay_app_public_key: getSetting(database, "alipay_app_public_key", ""),
    has_alipay_private_key: Boolean(getSecret(database, "alipay_private_key")),
    has_v1_key: Boolean(getSecret(database, "v1_key")),
    has_v2_platform_private_key: Boolean(getSecret(database, "v2_platform_private_key")),
  }));

  app.put("/settings", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const allowed = new Set([
      "public_base_url", "collection_mode", "transfer_user_id", "alipay_app_id",
      "alipay_endpoint", "alipay_public_key", "v1_enabled", "v2_enabled",
    ]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw new AppError(400, "UNKNOWN_SETTING", `不支持设置项 ${key}`);
    }
    if (typeof body.public_base_url === "string") setSetting(database, "public_base_url", validatePublicBaseUrl(body.public_base_url));
    if (body.collection_mode === "business_qr" || body.collection_mode === "transfer") setSetting(database, "collection_mode", body.collection_mode);
    if (typeof body.transfer_user_id === "string") {
      assert(/^\d{8,32}$/.test(body.transfer_user_id) || body.transfer_user_id === "", 400, "INVALID_TRANSFER_USER", "支付宝用户 ID 应为 8–32 位数字");
      setSetting(database, "transfer_user_id", body.transfer_user_id);
    }
    if (typeof body.alipay_app_id === "string") {
      assert(/^\d{8,32}$/.test(body.alipay_app_id) || body.alipay_app_id === "", 400, "INVALID_ALIPAY_APP_ID", "支付宝应用 ID 格式错误");
      setSetting(database, "alipay_app_id", body.alipay_app_id);
    }
    if (typeof body.alipay_endpoint === "string") {
      const endpoint = new URL(body.alipay_endpoint);
      assert(endpoint.protocol === "https:", 400, "INVALID_ALIPAY_ENDPOINT", "支付宝网关必须使用 HTTPS");
      setSetting(database, "alipay_endpoint", endpoint.toString().replace(/\/$/, ""));
    }
    if (typeof body.alipay_public_key === "string") {
      if (body.alipay_public_key) validatePublicKey(body.alipay_public_key);
      setSetting(database, "alipay_public_key", body.alipay_public_key ? toSpkiPublicKey(body.alipay_public_key) : "");
    }
    if (typeof body.v1_enabled === "boolean") setSetting(database, "v1_enabled", body.v1_enabled);
    if (typeof body.v2_enabled === "boolean") setSetting(database, "v2_enabled", body.v2_enabled);
    audit(database, "settings.update", { actor: c.get("admin").username, details: { keys: Object.keys(body) } });
    return c.json({ ok: true, settings: getPublicSettings(database) });
  });

  app.post("/settings/qr", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    assert(file instanceof File, 400, "QR_FILE_REQUIRED", "请选择二维码图片");
    assert(file.size > 0 && file.size <= 5 * 1024 * 1024, 400, "QR_FILE_SIZE", "二维码图片必须小于 5MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = imageType(bytes);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
    mkdirSync(getRuntimeEnv().uploadDir, { recursive: true });
    const filename = `business-qr-${hash}.${detected.ext}`;
    await Bun.write(resolve(getRuntimeEnv().uploadDir, filename), bytes);
    const url = `${getSetting(database, "public_base_url", "").replace(/\/$/, "")}/uploads/${filename}`;
    setSetting(database, "business_qr_url", url);
    audit(database, "settings.qr_upload", { actor: c.get("admin").username, details: { filename, mime: detected.mime, size: file.size } });
    return c.json({ ok: true, url });
  });

  app.post("/keys/alipay/generate", (c) => {
    const pair = generateRsaKeyPair();
    setSecret(database, "alipay_private_key", pair.privateKey);
    setSetting(database, "alipay_app_public_key", pair.publicKey);
    audit(database, "keys.alipay_generate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey });
  });

  app.put("/keys/alipay/private", async (c) => {
    const body = await c.req.json<{ private_key?: string }>();
    assert(body.private_key, 400, "PRIVATE_KEY_REQUIRED", "应用私钥不能为空");
    validatePrivateKey(body.private_key);
    setSecret(database, "alipay_private_key", toPkcs8PrivateKey(body.private_key));
    audit(database, "keys.alipay_import", { actor: c.get("admin").username });
    return c.json({ ok: true });
  });

  app.post("/keys/alipay/private/reveal", (c) => c.json({ private_key: getSecret(database, "alipay_private_key") }));

  app.post("/keys/v1/regenerate", (c) => {
    const pid = getSetting(database, "merchant_pid", "") || randomMerchantPid();
    const key = randomAlphaNumeric(32);
    setSetting(database, "merchant_pid", pid);
    setSecret(database, "v1_key", key);
    audit(database, "keys.v1_regenerate", { actor: c.get("admin").username });
    return c.json({ pid, key });
  });

  app.post("/keys/v1/reveal", (c) => c.json({
    pid: getSetting(database, "merchant_pid", ""),
    key: getSecret(database, "v1_key"),
  }));

  app.post("/keys/v2/platform/regenerate", (c) => {
    const pair = generateRsaKeyPair();
    setSecret(database, "v2_platform_private_key", pair.privateKey);
    setSetting(database, "v2_platform_public_key", pair.publicKey);
    audit(database, "keys.v2_platform_regenerate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey });
  });

  app.post("/keys/v2/merchant/generate", (c) => {
    const pair = generateRsaKeyPair();
    setSetting(database, "v2_merchant_public_key", pair.publicKey);
    audit(database, "keys.v2_merchant_generate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey, one_time: true });
  });

  app.put("/keys/v2/merchant", async (c) => {
    const body = await c.req.json<{ public_key?: string }>();
    assert(body.public_key, 400, "PUBLIC_KEY_REQUIRED", "商户公钥不能为空");
    validatePublicKey(body.public_key);
    setSetting(database, "v2_merchant_public_key", toSpkiPublicKey(body.public_key));
    audit(database, "keys.v2_merchant_import", { actor: c.get("admin").username });
    return c.json({ ok: true });
  });

  app.post("/alipay/test", async (c) => {
    const provider = new OfficialAlipayProvider(database);
    const now = new Date();
    const result = await provider.query({
      startTime: shanghaiTime(new Date(now.getTime() - 5 * 60_000)),
      endTime: shanghaiTime(now),
      pageNo: 1,
      pageSize: 1_000,
    });
    audit(database, "alipay.connection_test", { actor: c.get("admin").username, details: { traceId: result.traceId } });
    return c.json({ ok: true, trace_id: result.traceId, records: result.details.length });
  });

  app.put("/password", async (c) => {
    const body = await c.req.json<{ current_password?: string; new_password?: string }>();
    assert(body.current_password && body.new_password, 400, "PASSWORD_REQUIRED", "当前密码和新密码不能为空");
    assert(body.new_password.length >= 12 && body.new_password.length <= 128, 400, "INVALID_PASSWORD", "新密码须为 12–128 位");
    const admin = c.get("admin");
    const row = database.query("SELECT password_hash FROM admin_users WHERE id = ?").get(admin.id) as { password_hash: string };
    assert(await verifyPassword(body.current_password, row.password_hash), 401, "INVALID_PASSWORD", "当前密码错误");
    const hash = await createPasswordHash(body.new_password);
    database.query("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, new Date().toISOString(), admin.id);
    audit(database, "auth.password_change", { actor: admin.username });
    return c.json({ ok: true });
  });

  app.get("/system", (c) => {
    const settings = getPublicSettings(database);
    return c.json({
      ready: isGatewayReady(database),
      bun_version: Bun.version,
      database_path: getRuntimeEnv().databasePath,
      data_dir: getRuntimeEnv().dataDir,
      alipay_configured: settings.alipay_configured,
      active_mode_ready: settings.collection_mode === "business_qr" ? Boolean(settings.business_qr_url) : Boolean(getSetting(database, "transfer_user_id", "")),
      callbacks_private_allowed: settings.allow_private_callbacks,
    });
  });

  app.get("/docs", (c) => c.json({
    base_url: getSetting(database, "public_base_url", ""),
    pid: getSetting(database, "merchant_pid", ""),
    pay_type: "alipay",
    v1: {
      submit: "/submit.php",
      create: "/mapi.php",
      merchant: "/api.php?act=query",
      order: "/api.php?act=order",
      orders: "/api.php?act=orders",
      sign: "MD5(canonical + key)",
    },
    v2: {
      submit: "/api/pay/submit",
      create: "/api/pay/create",
      query: "/api/pay/query",
      merchant: "/api/merchant/info",
      orders: "/api/merchant/orders",
      sign: "SHA256WithRSA / PKCS#1 v1.5",
      timestamp_tolerance_seconds: 300,
    },
  }));

  return app;
}

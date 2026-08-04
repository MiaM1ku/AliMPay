import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDatabase } from "./db";
import { getSetting } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { randomToken, secureEqual, sha256 } from "./security";

export const SESSION_COOKIE = "alimpay_session";
export const CSRF_COOKIE = "alimpay_csrf";

export interface AdminUser {
  id: string;
  username: string;
  created_at: string;
}

export interface AuthVariables {
  admin: AdminUser;
}

interface LoginBucket {
  failures: number[];
  blockedUntil: number;
}

const loginBuckets = new Map<string, LoginBucket>();

export function clientIp(headers: Headers) {
  if (getRuntimeEnv().trustProxy) {
    return (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "").trim().slice(0, 128);
  }
  return "";
}

export function setupCompleted(database: AppDatabase) {
  return Boolean(database.query("SELECT 1 FROM admin_users LIMIT 1").get()) && getSetting(database, "setup_completed", false);
}

export function assertOriginAllowed(requestUrl: string, origin: string | undefined, database: AppDatabase) {
  if (!origin) return;
  const allowed = new Set<string>([new URL(requestUrl).origin]);
  try {
    allowed.add(new URL(getSetting(database, "public_base_url", "")).origin);
  } catch {
    // An invalid configured public URL is handled by settings validation.
  }
  if (!allowed.has(origin)) throw new AppError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}

export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  const bucket = loginBuckets.get(key);
  if (bucket?.blockedUntil && bucket.blockedUntil > now) {
    throw new AppError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试");
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const bucket = loginBuckets.get(key) ?? { failures: [], blockedUntil: 0 };
  bucket.failures = bucket.failures.filter((time) => now - time < 15 * 60_000);
  bucket.failures.push(now);
  if (bucket.failures.length >= 5) bucket.blockedUntil = now + 15 * 60_000;
  loginBuckets.set(key, bucket);
}

export function clearLoginFailures(key: string) {
  loginBuckets.delete(key);
}

export async function createPasswordHash(password: string) {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash, "argon2id");
}

export function createSession(database: AppDatabase, userId: string, headers: Headers) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60_000);
  database.query(`
    INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    userId,
    sha256(token),
    expires.toISOString(),
    now.toISOString(),
    now.toISOString(),
    clientIp(headers),
    (headers.get("user-agent") ?? "").slice(0, 512),
  );
  return { token, csrf, expires };
}

export function setAuthCookies(c: Parameters<typeof setCookie>[0], session: ReturnType<typeof createSession>) {
  const secure = getRuntimeEnv().nodeEnv === "production";
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
    expires: session.expires,
  });
  setCookie(c, CSRF_COOKIE, session.csrf, {
    httpOnly: false,
    secure,
    sameSite: "Strict",
    path: "/",
    expires: session.expires,
  });
}

export function clearAuthCookies(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
}

export function authMiddleware(database: AppDatabase): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? "";
    if (!token) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const now = new Date().toISOString();
    database.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const row = database.query(`
      SELECT u.id, u.username, u.created_at, s.token_hash
      FROM sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), now) as (AdminUser & { token_hash: string }) | null;
    if (!row) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");

    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      assertOriginAllowed(c.req.url, c.req.header("origin"), database);
      const csrfHeader = c.req.header("x-csrf-token") ?? "";
      const csrfCookie = getCookie(c, CSRF_COOKIE) ?? "";
      if (!csrfHeader || !csrfCookie || !secureEqual(csrfHeader, csrfCookie)) {
        throw new AppError(403, "CSRF_REJECTED", "CSRF 校验失败，请刷新页面后重试");
      }
    }

    database.query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, row.token_hash);
    c.set("admin", { id: row.id, username: row.username, created_at: row.created_at });
    await next();
  };
}

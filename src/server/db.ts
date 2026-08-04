import { Database, type SQLQueryBindings } from "bun:sqlite";
import { PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS } from "../shared/contracts";
import { getRuntimeEnv } from "./env";

export type AppDatabase = Database;

const MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  trade_no TEXT NOT NULL UNIQUE,
  pid TEXT NOT NULL,
  api_version TEXT NOT NULL CHECK(api_version IN ('v1', 'v2')),
  out_trade_no TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'alipay' CHECK(type = 'alipay'),
  name TEXT NOT NULL,
  requested_amount_cents INTEGER NOT NULL CHECK(requested_amount_cents > 0),
  payable_amount_cents INTEGER NOT NULL CHECK(payable_amount_cents > 0),
  collection_mode TEXT NOT NULL CHECK(collection_mode IN ('business_qr', 'transfer')),
  notify_url TEXT NOT NULL,
  return_url TEXT,
  param TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  checkout_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'expired', 'paid', 'late_paid')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  monitor_until TEXT NOT NULL,
  paid_at TEXT,
  alipay_account_log_id TEXT UNIQUE,
  alipay_order_no TEXT,
  buyer TEXT NOT NULL DEFAULT '',
  raw_request_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(pid, out_trade_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_status_monitor ON orders(status, monitor_until);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_out_trade_no ON orders(out_trade_no);

CREATE TABLE IF NOT EXISTS amount_reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL UNIQUE,
  reserved_until TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amount_reservations_until ON amount_reservations(reserved_until);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_log_id TEXT NOT NULL UNIQUE,
  matched_order_id TEXT REFERENCES orders(id),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  alipay_order_no TEXT,
  trans_memo TEXT,
  other_account TEXT,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(matched_order_id);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped')),
  active_orders INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  trace_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_started ON scan_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TEXT NOT NULL,
  last_http_status INTEGER,
  last_error TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_due ON notification_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_order ON notification_jobs(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  response_status INTEGER,
  response_body TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
`;

const DEFAULT_SETTINGS: Record<string, unknown> = {
  setup_completed: false,
  public_base_url: "",
  collection_mode: "business_qr",
  transfer_link_layer: 5,
  payment_poll_interval_seconds: PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS,
  business_qr_url: "",
  alipay_app_id: "",
  alipay_endpoint: "https://openapi.alipay.com",
  alipay_public_key: "",
  v1_enabled: true,
  v2_enabled: true,
  merchant_pid: "",
  v2_platform_public_key: "",
  v2_merchant_public_key: "",
  surcharge_max_cents: 99,
};

export function createDatabase(path = getRuntimeEnv().databasePath): AppDatabase {
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec(MIGRATION);
  const now = new Date().toISOString();
  database.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now);
  const insert = database.query("INSERT OR IGNORE INTO settings(key, value_json, is_secret, updated_at) VALUES (?, ?, 0, ?)");
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, JSON.stringify(value), now);
  if (!getSetting<string>(database, "public_base_url", "")) {
    setSetting(database, "public_base_url", getRuntimeEnv().publicBaseUrl);
  }
  return database;
}

let singleton: AppDatabase | undefined;

export function getDatabase() {
  singleton ??= createDatabase();
  return singleton;
}

export function closeDatabase() {
  singleton?.close();
  singleton = undefined;
}

export function getSetting<T>(database: AppDatabase, key: string, fallback: T): T {
  const row = database.query("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(database: AppDatabase, key: string, value: unknown, isSecret = false) {
  database.query(`
    INSERT INTO settings(key, value_json, is_secret, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, is_secret = excluded.is_secret, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), isSecret ? 1 : 0, new Date().toISOString());
}

export function queryAll<T>(database: AppDatabase, sql: string, ...bindings: SQLQueryBindings[]) {
  return database.query(sql).all(...bindings) as T[];
}

export function audit(database: AppDatabase, action: string, options: {
  actor?: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  details?: Record<string, unknown>;
} = {}) {
  database.query(`
    INSERT INTO audit_logs(actor, action, target_type, target_id, ip, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.actor ?? "system",
    action,
    options.targetType ?? null,
    options.targetId ?? null,
    options.ip ?? "",
    JSON.stringify(options.details ?? {}),
    new Date().toISOString(),
  );
}

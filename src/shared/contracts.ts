export type ApiVersion = "v1" | "v2";
export type CollectionMode = "business_qr" | "transfer";
export type TransferLinkLayer = 1 | 2 | 3 | 4 | 5;
export type OrderStatus = "pending" | "expired" | "paid" | "late_paid";

export const PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS = 5;
export const PAYMENT_POLL_INTERVAL_MIN_SECONDS = 1;
export const PAYMENT_POLL_INTERVAL_MAX_SECONDS = 60;

export interface OrderRecord {
  id: string;
  trade_no: string;
  pid: string;
  api_version: ApiVersion;
  out_trade_no: string;
  type: "alipay";
  name: string;
  requested_amount_cents: number;
  payable_amount_cents: number;
  collection_mode: CollectionMode;
  notify_url: string;
  return_url: string | null;
  param: string;
  client_ip: string;
  checkout_token: string;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  monitor_until: string;
  paid_at: string | null;
  alipay_account_log_id: string | null;
  alipay_order_no: string | null;
  buyer: string;
}

export interface DashboardData {
  today_order_count: number;
  today_paid_count: number;
  today_paid_cents: number;
  pending_count: number;
  late_paid_count: number;
  notify_failed_count: number;
  active_monitors: number;
  last_scan: ScanRun | null;
  recent_orders: OrderRecord[];
  configured: boolean;
  collection_mode: CollectionMode;
}

export interface ScanRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error" | "skipped";
  active_orders: number;
  pages: number;
  records: number;
  matched: number;
  error: string | null;
  trace_id: string | null;
}

export interface PublicSettings {
  setup_completed: boolean;
  public_base_url: string;
  collection_mode: CollectionMode;
  transfer_link_layer: TransferLinkLayer;
  payment_poll_interval_seconds: number;
  business_qr_url: string;
  alipay_app_id: string;
  alipay_endpoint: string;
  alipay_configured: boolean;
  v1_enabled: boolean;
  v2_enabled: boolean;
  merchant_pid: string;
  v1_key_masked: string;
  v2_platform_public_key: string;
  v2_merchant_public_key: string;
  allow_private_callbacks: boolean;
}

export interface CheckoutData {
  trade_no: string;
  out_trade_no: string;
  name: string;
  requested_money: string;
  payable_money: string;
  collection_mode: CollectionMode;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  monitor_until: string;
  payment_poll_interval_seconds: number;
  payment_uri: string;
  business_qr_url: string;
  return_url: string | null;
  return_target: string | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

import type { CollectionMode, PublicSettings } from "../shared/contracts";
import { getSetting, setSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { decryptSecret, encryptSecret } from "./security";

export const SECRET_SETTING_KEYS = [
  "alipay_private_key",
  "v1_key",
  "v2_platform_private_key",
] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

export function getSecret(database: AppDatabase, key: SecretSettingKey) {
  const encrypted = getSetting<string>(database, key, "");
  return encrypted ? decryptSecret(encrypted, getRuntimeEnv().masterKey) : "";
}

export function setSecret(database: AppDatabase, key: SecretSettingKey, value: string) {
  setSetting(database, key, value ? encryptSecret(value, getRuntimeEnv().masterKey) : "", true);
}

export function getPublicSettings(database: AppDatabase): PublicSettings {
  const v1Key = getSecret(database, "v1_key");
  return {
    setup_completed: getSetting(database, "setup_completed", false),
    public_base_url: getSetting(database, "public_base_url", getRuntimeEnv().publicBaseUrl),
    collection_mode: getSetting<CollectionMode>(database, "collection_mode", "business_qr"),
    business_qr_url: getSetting(database, "business_qr_url", ""),
    alipay_app_id: getSetting(database, "alipay_app_id", ""),
    alipay_endpoint: getSetting(database, "alipay_endpoint", "https://openapi.alipay.com"),
    alipay_configured: Boolean(
      getSetting(database, "alipay_app_id", "") &&
      getSecret(database, "alipay_private_key") &&
      getSetting(database, "alipay_public_key", ""),
    ),
    v1_enabled: getSetting(database, "v1_enabled", true),
    v2_enabled: getSetting(database, "v2_enabled", true),
    merchant_pid: getSetting(database, "merchant_pid", ""),
    v1_key_masked: v1Key ? `${v1Key.slice(0, 4)}••••••••${v1Key.slice(-4)}` : "",
    v2_platform_public_key: getSetting(database, "v2_platform_public_key", ""),
    v2_merchant_public_key: getSetting(database, "v2_merchant_public_key", ""),
    allow_private_callbacks: getRuntimeEnv().allowPrivateCallbacks,
  };
}

export function isGatewayReady(database: AppDatabase) {
  const settings = getPublicSettings(database);
  if (!settings.setup_completed || !settings.merchant_pid || !settings.alipay_configured) return false;
  if (settings.collection_mode === "business_qr" && !settings.business_qr_url) return false;
  return true;
}

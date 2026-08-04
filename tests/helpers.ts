import type { CollectionMode } from "../src/shared/contracts";
import { setSecret } from "../src/server/config";
import { createDatabase, setSetting } from "../src/server/db";
import { generateRsaKeyPair } from "../src/server/security";

export function configuredDatabase(mode: CollectionMode = "business_qr") {
  const database = createDatabase(":memory:");
  const alipay = generateRsaKeyPair();
  const platform = generateRsaKeyPair();
  const merchant = generateRsaKeyPair();
  setSetting(database, "setup_completed", true);
  setSetting(database, "public_base_url", "http://localhost");
  setSetting(database, "merchant_pid", "1000000001");
  setSetting(database, "collection_mode", mode);
  setSetting(database, "business_qr_url", "http://localhost/uploads/business-qr-0123456789abcdef.png");
  setSetting(database, "transfer_user_id", "2088000000000000");
  setSetting(database, "alipay_app_id", "2026000000000000");
  setSetting(database, "alipay_public_key", alipay.publicKey);
  setSecret(database, "alipay_private_key", alipay.privateKey);
  setSecret(database, "v1_key", "1234567890abcdef1234567890abcdef");
  setSecret(database, "v2_platform_private_key", platform.privateKey);
  setSetting(database, "v2_platform_public_key", platform.publicKey);
  setSetting(database, "v2_merchant_public_key", merchant.publicKey);
  return { database, alipay, platform, merchant };
}

export function orderInput(index = 1) {
  return {
    pid: "1000000001",
    apiVersion: "v1" as const,
    outTradeNo: `ORDER-${index}`,
    name: `Test order ${index}`,
    money: "1.00",
    notifyUrl: "https://8.8.8.8/notify",
    returnUrl: "https://8.8.8.8/return",
    param: `p${index}`,
    clientIp: "203.0.113.10",
  };
}

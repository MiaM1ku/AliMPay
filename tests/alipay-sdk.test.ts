import { createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { AlipaySdk } from "alipay-sdk";
import { prepareAlipaySdkPem } from "../src/server/alipay";
import { generateRsaKeyPair } from "../src/server/security";

describe("Alipay SDK key compatibility", () => {
  it("removes trailing PEM whitespace before the SDK formats generated keys", () => {
    const pair = generateRsaKeyPair();
    expect(pair.privateKey.endsWith("\n")).toBe(true);

    const sdk = new AlipaySdk({
      appId: "2026000000000000",
      privateKey: prepareAlipaySdkPem(pair.privateKey),
      alipayPublicKey: prepareAlipaySdkPem(pair.publicKey),
      keyType: "PKCS8",
      signType: "RSA2",
    });

    expect(() => createPrivateKey(sdk.config.privateKey)).not.toThrow();
    expect(() => createPublicKey(sdk.config.alipayPublicKey!)).not.toThrow();
    expect(() => createSign("RSA-SHA256").update("probe").sign(sdk.config.privateKey)).not.toThrow();
  });
});

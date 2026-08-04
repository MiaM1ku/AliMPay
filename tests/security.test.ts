import { describe, expect, it } from "bun:test";
import {
  canonicalize,
  decryptSecret,
  encryptSecret,
  generateRsaKeyPair,
  isPrivateAddress,
  md5Sign,
  parseMoneyToCents,
  rsaSign,
  rsaVerify,
  validateCallbackUrl,
  verifyMd5,
} from "../src/server/security";

describe("signature primitives", () => {
  const parameters = {
    type: "alipay",
    pid: "1001",
    money: "1.00",
    name: "VIP",
    out_trade_no: "20240001",
    sign_type: "MD5",
    empty: "",
    array: ["ignored"],
  };

  it("matches the fixed V1 MD5 vector", () => {
    expect(canonicalize(parameters)).toBe("money=1.00&name=VIP&out_trade_no=20240001&pid=1001&type=alipay");
    expect(md5Sign(parameters, "1234567890abcdef1234567890abcdef")).toBe("c1182a7f25573cd05a52b0288f5c1c62");
    expect(verifyMd5({ ...parameters, sign: "c1182a7f25573cd05a52b0288f5c1c62" }, "1234567890abcdef1234567890abcdef")).toBe(true);
  });

  it("generates PKCS8/SPKI keys and verifies deterministic RSA signatures", () => {
    const pair = generateRsaKeyPair();
    expect(pair.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(pair.publicKey).toContain("BEGIN PUBLIC KEY");
    const payload = { pid: "1001", timestamp: "1721206072", amount: "1.00" };
    const first = rsaSign(payload, pair.privateKey);
    const second = rsaSign(payload, pair.privateKey);
    const barePrivateKey = pair.privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
    const barePublicKey = pair.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
    const bareSignature = rsaSign(payload, barePrivateKey);
    expect(first).toBe(second);
    expect(rsaVerify({ ...payload, sign: first, sign_type: "RSA" }, pair.publicKey)).toBe(true);
    expect(rsaVerify({ ...payload, sign: bareSignature, sign_type: "RSA" }, barePublicKey)).toBe(true);
    expect(rsaVerify({ ...payload, amount: "2.00", sign: first }, pair.publicKey)).toBe(false);
  });
});

describe("secret and input security", () => {
  it("round-trips AES-256-GCM and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptSecret("private-value", key);
    expect(encrypted).not.toContain("private-value");
    expect(decryptSecret(encrypted, key)).toBe("private-value");
    const parts = encrypted.split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    parts[3] = ciphertext.toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  it("parses money as integer cents without floating point", () => {
    expect(parseMoneyToCents("1")).toBe(100);
    expect(parseMoneyToCents("0.01")).toBe(1);
    expect(parseMoneyToCents("123.45")).toBe(12_345);
    expect(() => parseMoneyToCents("1.001")).toThrow();
    expect(() => parseMoneyToCents("0")).toThrow();
  });

  it("blocks common SSRF destinations", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "::ffff:7f00:1", "2001:db8::1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(() => validateCallbackUrl("http://localhost/callback", false)).toThrow();
    expect(() => validateCallbackUrl("file:///etc/passwd", false)).toThrow();
    expect(validateCallbackUrl("https://example.com/callback", false).hostname).toBe("example.com");
  });
});

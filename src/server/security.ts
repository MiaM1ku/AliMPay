import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const OMIT_FROM_SIGNATURE = new Set(["sign", "sign_type"]);

export function canonicalize(parameters: Record<string, unknown>) {
  return Object.entries(parameters)
    .filter(([key, value]) => {
      if (OMIT_FROM_SIGNATURE.has(key)) return false;
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) || value instanceof Uint8Array) return false;
      return typeof value !== "object";
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function md5Sign(parameters: Record<string, unknown>, key: string) {
  return createHash("md5").update(`${canonicalize(parameters)}${key}`, "utf8").digest("hex");
}

export function secureEqual(valueA: string, valueB: string) {
  const a = Buffer.from(valueA);
  const b = Buffer.from(valueB);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyMd5(parameters: Record<string, unknown>, key: string) {
  const actual = typeof parameters.sign === "string" ? parameters.sign.toLowerCase() : "";
  return actual.length === 32 && secureEqual(actual, md5Sign(parameters, key));
}

export type PemKind = "private" | "public";

export function normalizePem(value: string, kind: PemKind) {
  const clean = value.trim().replace(/\r/g, "");
  if (clean.includes("-----BEGIN")) return `${clean}\n`;
  const body = clean.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? clean;
  const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export interface RsaKeyPair {
  privateKey: string;
  publicKey: string;
}

export function generateRsaKeyPair(): RsaKeyPair {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export function rsaSign(parameters: Record<string, unknown>, privateKey: string) {
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalize(parameters), "utf8");
  signer.end();
  return signer.sign({ key: createPrivateKey(normalizePem(privateKey, "private")), padding: 1 }, "base64");
}

export function rsaVerify(parameters: Record<string, unknown>, publicKey: string) {
  if (typeof parameters.sign !== "string" || !parameters.sign) return false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(canonicalize(parameters), "utf8");
    verifier.end();
    return verifier.verify(
      { key: createPublicKey(normalizePem(publicKey, "public")), padding: 1 },
      parameters.sign,
      "base64",
    );
  } catch {
    return false;
  }
}

export function validatePrivateKey(value: string) {
  createPrivateKey(normalizePem(value, "private"));
}

export function validatePublicKey(value: string) {
  createPublicKey(normalizePem(value, "public"));
}

export function toPkcs8PrivateKey(value: string) {
  return createPrivateKey(normalizePem(value, "private")).export({ type: "pkcs8", format: "pem" }).toString();
}

export function toSpkiPublicKey(value: string) {
  return createPublicKey(normalizePem(value, "public")).export({ type: "spki", format: "pem" }).toString();
}

export function encryptSecret(plaintext: string, masterKey: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(envelope: string, masterKey: Buffer) {
  if (!envelope) return "";
  const [version, rawIv, rawTag, rawCiphertext] = envelope.split(".");
  if (version !== "v1" || !rawIv || !rawTag || !rawCiphertext) throw new Error("密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(rawIv, "base64url"));
  decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(rawCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomDigits(length: number) {
  let output = "";
  while (output.length < length) output += String(randomBytes(1)[0]! % 10);
  return output.slice(0, length);
}

export function randomMerchantPid() {
  return `${1 + (randomBytes(1)[0]! % 9)}${randomDigits(9)}`;
}

export function randomAlphaNumeric(length: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let output = "";
  while (output.length < length) output += alphabet[randomBytes(1)[0]! % alphabet.length];
  return output;
}

export function parseMoneyToCents(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(raw)) throw new Error("金额格式错误，必须是最多两位小数的正数");
  const [yuan, fraction = ""] = raw.split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("金额必须大于 0");
  return cents;
}

export function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

export function validateCallbackUrl(value: string, allowPrivate: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("回调地址不是有效 URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("回调地址只允许 HTTP/HTTPS");
  if (url.username || url.password) throw new Error("回调地址不能包含用户名或密码");
  if (!allowPrivate && isPrivateHostname(url.hostname)) throw new Error("回调地址不能指向本机或私有网络");
  return url;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
  return isIP(normalized) > 0 && isPrivateAddress(normalized);
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) {
    const groups = expandIpv6(value);
    if (!groups) return true;
    if (groups.every((group) => group === 0) || groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
    if ((groups[0]! & 0xfe00) === 0xfc00 || (groups[0]! & 0xffc0) === 0xfe80 || (groups[0]! & 0xff00) === 0xff00) return true;
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return isPrivateAddress(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
    }
    return false;
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function expandIpv6(address: string) {
  let normalized = address;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const bytes = dotted.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((byte) => byte < 0 || byte > 255)) return null;
    normalized = normalized.slice(0, -dotted.length) + `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || missing < 0) return null;
  const raw = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const groups = raw.map((group) => /^[a-f\d]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN);
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

export async function assertPublicDestination(url: URL, allowPrivate: boolean) {
  if (allowPrivate) return;
  const results = await lookup(url.hostname, { all: true, verbatim: true });
  if (results.length === 0 || results.some((result) => isPrivateAddress(result.address))) {
    throw new Error("回调域名解析到了私有或保留地址");
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface RuntimeEnv {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  uploadDir: string;
  publicBaseUrl: string;
  allowPrivateCallbacks: boolean;
  trustProxy: boolean;
  masterKey: Buffer;
}

function boolEnv(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function decodeMasterKey(raw: string) {
  if (/^[a-f\d]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("APP_MASTER_KEY 必须是 32 字节 Base64 或 64 位十六进制，不能使用普通密码");
}

function loadMasterKey(dataDir: string) {
  const fromEnv = process.env.APP_MASTER_KEY?.trim();
  if (fromEnv) return decodeMasterKey(fromEnv);

  const keyPath = resolve(dataDir, ".master-key");
  if (existsSync(keyPath)) return decodeMasterKey(readFileSync(keyPath, "utf8").trim());

  const generated = randomBytes(32).toString("base64");
  try {
    writeFileSync(keyPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return decodeMasterKey(readFileSync(keyPath, "utf8").trim());
    }
    throw error;
  }
  return Buffer.from(generated, "base64");
}

let cached: RuntimeEnv | undefined;

export function getRuntimeEnv(): RuntimeEnv {
  if (cached) return cached;
  const rawNodeEnv = process.env.NODE_ENV ?? "development";
  const nodeEnv: RuntimeEnv["nodeEnv"] = rawNodeEnv === "production" || rawNodeEnv === "test" ? rawNodeEnv : "development";
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const uploadDir = resolve(dataDir, "uploads");
  mkdirSync(uploadDir, { recursive: true });

  cached = {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 3000,
    dataDir,
    databasePath: resolve(dataDir, "alimpay.sqlite"),
    uploadDir,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number.isFinite(port) ? port : 3000}`).replace(/\/$/, ""),
    allowPrivateCallbacks: boolEnv(process.env.ALLOW_PRIVATE_CALLBACKS),
    trustProxy: boolEnv(process.env.TRUST_PROXY),
    masterKey: loadMasterKey(dataDir),
  };
  return cached;
}

export function resetRuntimeEnvForTests() {
  cached = undefined;
}

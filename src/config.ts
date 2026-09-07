/**
 * Central runtime configuration, loaded from environment variables (.env).
 * Fails fast on invalid values so misconfiguration surfaces at boot, not later.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import "dotenv/config";

export const isProd = process.env.NODE_ENV === "production";

function str(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    if (def !== undefined) return def;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `Environment variable ${name} must be a non-negative integer (got: ${raw})`,
    );
  }
  return n;
}

const mayaUrl = str("MAYA_URL", "http://localhost:3000").replace(/\/+$/, "");
if (!/^https?:\/\/[^\s]+$/.test(mayaUrl)) {
  throw new Error(`MAYA_URL must be an absolute http(s) URL (got: ${mayaUrl})`);
}

const uploadDir = path.resolve(str("UPLOAD_DIR", "./data/uploads"));
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(str("DB_PATH", "./data/mayaspace.db"))), {
  recursive: true,
});
fs.mkdirSync(path.resolve("logs"), { recursive: true });
fs.mkdirSync(path.resolve("data", "sessions"), { recursive: true });

const cookieSecureRaw = str("COOKIE_SECURE", "auto").toLowerCase();
if (!["auto", "true", "false"].includes(cookieSecureRaw)) {
  throw new Error(`COOKIE_SECURE must be "auto", "true" or "false" (got: ${cookieSecureRaw})`);
}

let sessionSecret = process.env.SESSION_SECRET?.trim() ?? "";
if (sessionSecret.length < 32) {
  if (isProd) {
    throw new Error(
      "SESSION_SECRET must be set to at least 32 characters in production. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  console.warn("[config] SESSION_SECRET missing or short — using an ephemeral secret (dev only).");
  sessionSecret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

function handleList(name: string): string[] {
  const raw = process.env[name]?.trim() ?? "";
  if (raw === "") return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

if (isProd) {
  for (const name of ["ADMIN_HANDLES", "MODERATOR_HANDLES"]) {
    for (const h of handleList(name)) {
      if (!HANDLE_RE.test(h)) {
        throw new Error(`${name} contains an invalid handle: "${h}"`);
      }
    }
  }
}

export const config = {
  /** Canonical public origin of this instance, used for all actor/object IRIs. */
  mayaUrl,
  port: int("PORT", 3000),
  siteName: str("SITE_NAME", "MayaSpace"),
  siteTagline: str("SITE_TAGLINE", "A place for friends."),
  sessionSecret,
  adminHandles: handleList("ADMIN_HANDLES"),
  moderatorHandles: handleList("MODERATOR_HANDLES"),
  dbPath: path.resolve(str("DB_PATH", "./data/mayaspace.db")),
  uploadDir,
  maxUploadMb: Math.max(1, int("MAX_UPLOAD_MB", 10)),
  attachmentsPerPost: Math.max(0, Math.min(12, int("ATTACHMENTS_PER_POST", 4))),
  postMaxChars: Math.max(1, int("POST_MAX_CHARS", 10000)),
  commentMaxChars: Math.max(1, int("COMMENT_MAX_CHARS", 3000)),
  cookieSecure:
    cookieSecureRaw === "auto" ? mayaUrl.startsWith("https://") : cookieSecureRaw === "true",
  trustProxy: int("TRUST_PROXY", 0),
  logLevel: str("LOG_LEVEL", isProd ? "info" : "debug"),
  /** Software identity reported via NodeInfo. */
  software: { name: "mayaspace", version: "1.0.0" },
} as const;

export type AppConfig = typeof config;
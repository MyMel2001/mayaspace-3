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

const port = int("PORT", 3000);

// An explicit port in MAYA_URL must match PORT: every actor/note IRI is
// minted from MAYA_URL, so a mismatch (MAYA_URL=http://localhost:3000 while
// the server actually listens on PORT=3474) advertises unreachable actor
// IRIs — remote servers 202 our deliveries but can't dereference our
// actors' keys or profiles, so follows never confirm and everything
// federation-side silently rots. Fail fast instead.
const mayaUrlPort = new URL(mayaUrl).port;
if (mayaUrlPort !== "" && mayaUrlPort !== String(port)) {
  throw new Error(
    `MAYA_URL port (${mayaUrlPort}) does not match PORT (${port}). ` +
      "Actor IRIs are minted from MAYA_URL, so these must agree.",
  );
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

const trustProxyHops = int("TRUST_PROXY", 0);

// Dev instances run on localhost/LAN origins, where the remote side is also a
// private address: Fedify refuses to fetch actor documents or WebFinger
// descriptors on such hosts unless explicitly allowed. Production instances
// (public MAYA_URL) must never enable it.
const allowPrivateFediverseAddresses =
  !isProd && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.localhost)(:\d+)?$/i.test(mayaUrl);

// A https MAYA_URL with zero trusted proxies means TLS terminates elsewhere
// (Cloudflare/nginx/Caddy…). Express then believes requests are plain HTTP,
// express-session suppresses its `secure` cookie, and login sessions never
// stick — a misconfiguration that previously failed silently at login time.
// Refuse to boot rather than let it surface as "can't stay logged in".
if (mayaUrl.startsWith("https://") && trustProxyHops === 0) {
  throw new Error(
    "MAYA_URL is https but TRUST_PROXY=0. Set TRUST_PROXY=1 (or more) behind " +
      "a TLS-terminating proxy, otherwise secure session cookies are never " +
      "sent and users cannot stay logged in.",
  );
}

export const config = {
  /** Canonical public origin of this instance, used for all actor/object IRIs. */
  mayaUrl,
  port,
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
  trustProxy: trustProxyHops,
  /** Allow fetching private/localhost fediverse URLs (localhost-only dev). */
  allowPrivateFediverseAddresses,
  logLevel: str("LOG_LEVEL", isProd ? "info" : "debug"),
  /** Software identity reported via NodeInfo. */
  software: { name: "mayaspace", version: "1.0.0" },
} as const;

export type AppConfig = typeof config;
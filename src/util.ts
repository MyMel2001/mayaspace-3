/**
 * Small shared helpers: ids, tokens, password hashing, formatting, validation.
 */
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const REMOTE_HANDLE_RE = /^[a-z0-9._\-]{1,64}@[a-z0-9.\-]{1,255}$/i;

export function newId(): string {
  return randomUUID();
}

/** URL-safe random token (default 32 bytes = 43 chars). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${dk.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const dk = await scrypt(password, salt, expected.length);
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

const ENTITIES: Record<string, string> = {
  "\u0026": "\u0026amp;",
  "\u003C": "\u0026lt;",
  "\u003E": "\u0026gt;",
  "\u0022": "\u0026quot;",
  "\u0027": "\u0026#39;",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z#0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "3 minutes ago"-style relative timestamps for the retro vibe. */
export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "a while ago";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Parses an absolute http(s) URL or returns null. Never throws. */
export function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Splits a "user@host" fediverse handle, validating both parts. */
export function parseRemoteHandle(raw: string): { user: string; host: string } | null {
  const cleaned = raw.trim().replace(/^@+/, "").replace(/^acct:/i, "").toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at <= 0 || at === cleaned.length - 1) return null;
  const user = cleaned.slice(0, at);
  const host = cleaned.slice(at + 1);
  if (!REMOTE_HANDLE_RE.test(cleaned)) return null;
  return { user, host };
}
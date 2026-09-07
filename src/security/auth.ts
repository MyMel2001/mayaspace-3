/**
 * Express middleware: sessions (SQLite-backed), CSRF double-submit (signed
 * cookie + per-session token), authentication gates, role gates, and rate
 * limiting. A CSRF token is minted on first render and required on every
 * state-changing POST — forms embed it as a hidden input.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { Role, UserRecord } from "../types.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";

const log = appLog("auth");

const SQLiteStore = SQLiteStoreFactory(session) as unknown as new (
  options: { db: string; dir: string; table?: string },
) => session.Store;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
      csrfToken?: string;
    }
  }
}

export function sessionMiddleware(): RequestHandler {
  const sessionDir = path.resolve("data", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return session({
    name: "mayaspace.sid",
    secret: config.sessionSecret,
    store: new SQLiteStore({
      db: "sessions.db",
      dir: sessionDir,
      table: "sessions",
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 14, // 2 weeks
    },
  });
}

// ── CSRF ─────────────────────────────────────────────────────────────────────
//
// Tokens ride two independent carriers so a lost/expired session (cookie not
// sent, new device, session store rotation, localhost vs 127.0.0.1 origin
// mismatch…) can no longer hard-fail every form POST:
//
//   1. signed cookie  — HMAC(secret, random secret) double-submit cookie,
//     minted on first render; the form echoes the full "secret.signature"
//     value back, and the guard verifies the signature server-side. The HMAC
//     makes it impossible for an attacker to plant a cookie AND a matching
//     form field without knowing the server secret.
//   2. per-session token — the original carrier, still accepted so sessions
//     that already carry one keep working across a deploy.
//
// The guard accepts EITHER carrier. SameSite=Lax on both cookies blocks
// cross-site form posts from even delivering credentials, so this stays a
// genuine CSRF defense rather than token theater.

const CSRF_COOKIE = "mayaspace.csrf";
const CSRF_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 2 weeks, mirrors session maxAge

function signCsrf(secret: string): string {
  const sig = createHmac("sha256", config.sessionSecret).update(secret).digest("base64url");
  return `${secret}.${sig}`;
}

/** Read a single cookie from the raw Cookie header (no cookie-parser dep). */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== "string" || header === "") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

function verifySigned(value: string): boolean {
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const secret = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (secret.length < 32) return false;
  // Compare base64url digests as equal-length UTF-8 buffers (timing-safe).
  const expected = createHmac("sha256", config.sessionSecret).update(secret).digest("base64url");
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/**
 * Issue (or reuse) the render-time CSRF token. Whichever carrier already
 * holds a valid token is reused, and the signed cookie is (re)synced to it so
 * BOTH carriers always carry the same secret at render time — either one can
 * then verify the POST even if the other is lost in between.
 */
export function issueCsrfToken(req: Request, res: Response): string {
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    maxAge: CSRF_TTL_MS,
    path: "/",
  };
  // 1) Existing per-session token: keep working, sync the cookie to it.
  if (typeof req.session?.csrfToken === "string" && req.session.csrfToken.length >= 32) {
    const token = req.session.csrfToken;
    req.csrfToken = token;
    res.cookie(CSRF_COOKIE, signCsrf(token), cookieOpts);
    return token;
  }
  // 2) Valid signed cookie: reuse its secret (session may be gone entirely).
  const cookieToken = readCookie(req.headers.cookie, CSRF_COOKIE);
  if (typeof cookieToken === "string" && verifySigned(cookieToken)) {
    const secret = cookieToken.slice(0, cookieToken.indexOf("."));
    req.csrfToken = secret;
    if (req.session) req.session.csrfToken = secret;
    return secret;
  }
  // 3) Mint fresh and seed both carriers.
  const secret = randomBytes(32).toString("base64url");
  req.csrfToken = secret;
  if (req.session) req.session.csrfToken = secret;
  res.cookie(CSRF_COOKIE, signCsrf(secret), cookieOpts);
  return secret;
}

/** CSRF gate for every state-changing POST. */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") {
    next();
    return;
  }
  const supplied = typeof req.body?.csrf === "string" ? req.body.csrf : undefined;
  if (supplied === undefined) {
    res.status(403).render("error", {
      pageTitle: "Forbidden",
      message: "Your session expired or the form is missing its security token. Please go back and try again.",
      user: req.user ?? null,
    });
    return;
  }
  // Carrier 1: per-session token.
  const sessionToken = req.session?.csrfToken;
  if (typeof sessionToken === "string" && safeEq(sessionToken, supplied)) {
    next();
    return;
  }
  // Carrier 2: signed double-submit cookie. The submitted value must match
  // the secret half of the signed cookie, and the cookie must carry a valid
  // HMAC over it — an attacker can forge neither without the server secret.
  const cookieToken = readCookie(req.headers.cookie, CSRF_COOKIE);
  if (typeof cookieToken === "string" && verifySigned(cookieToken)) {
    const secret = cookieToken.slice(0, cookieToken.indexOf("."));
    if (safeEq(secret, supplied)) {
      next();
      return;
    }
  }
  log.warn`CSRF verification failed for ${req.path} (user: ${req.user?.handle ?? "anonymous"}, carrier: ${typeof sessionToken === "string" ? "session" : typeof cookieToken === "string" ? "cookie" : "none"})`;
  res.status(403).render("error", {
    pageTitle: "Forbidden",
    message: "Invalid security token. Please go back, refresh the page, and try again.",
    user: req.user ?? null,
  });
}

function safeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── auth gates ───────────────────────────────────────────────────────────────

/** Loads the signed-in user onto req.user (or leaves it undefined). */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.session.userId !== undefined) {
    try {
      const user = await store.getUserById(req.session.userId);
      if (user && !user.suspended) req.user = user;
      else if (user?.suspended) {
        // session belongs to a suspended account — sign them out
        req.session.userId = undefined;
        req.session.handle = undefined;
      }
    } catch (err) {
      log.error`Failed to load session user: ${err}`;
    }
  }
  next();
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    res.redirect("/login");
    return;
  }
  next();
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.redirect("/login");
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).render("error", {
        pageTitle: "Forbidden",
        message: "You do not have permission to do that.",
        user: req.user,
      });
      return;
    }
    next();
  };
}

export function isAdmin(user: UserRecord | undefined): boolean {
  return user?.role === "admin";
}

export function isModerator(user: UserRecord | undefined): boolean {
  return user?.role === "admin" || user?.role === "moderator";
}

// ── rate limiters ────────────────────────────────────────────────────────────

export const generalLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests — slow down." },
});

export const authLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  limit: 25,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts — try again in 15 minutes." },
});

export const postLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Posting too fast — take a breath." },
});

export const uploadLimiter: RequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many uploads — try again in a minute." },
});
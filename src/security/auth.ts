/**
 * Express middleware: sessions (SQLite-backed), CSRF double-submit with a
 * per-session token, authentication gates, role gates, and rate limiting.
 * CSRF token is minted on first render and required on every state-changing
 * POST — forms embed it as a hidden input.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { Role, UserRecord } from "../types.js";
import { timingSafeEqual } from "node:crypto";
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

export function issueCsrfToken(req: Request): string {
  if (typeof req.session.csrfToken === "string" && req.session.csrfToken.length >= 32) {
    req.csrfToken = req.session.csrfToken;
    return req.session.csrfToken;
  }
  const token = randomBytes(32).toString("base64url");
  req.session.csrfToken = token;
  req.csrfToken = token;
  return token;
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") {
    next();
    return;
  }
  const sessionToken = req.session.csrfToken;
  const supplied = req.body?.csrf;
  if (typeof sessionToken !== "string" || typeof supplied !== "string") {
    res.status(403).render("error", {
      pageTitle: "Forbidden",
      message: "Your session expired or the form is missing its security token. Please go back and try again.",
      user: req.user ?? null,
    });
    return;
  }
  const a = Buffer.from(sessionToken);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    log.warn`CSRF token mismatch for ${req.path} (user: ${req.user?.handle ?? "anonymous"})`;
    res.status(403).render("error", {
      pageTitle: "Forbidden",
      message: "Invalid security token. Please go back, refresh the page, and try again.",
      user: req.user ?? null,
    });
    return;
  }
  next();
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
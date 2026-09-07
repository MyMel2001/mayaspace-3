/**
 * Shared render-context helper: every view receives user/flash/csrf/site
 * basics so templates can stay consistent.
 */
import type { NextFunction, Request, Response } from "express";
import { issueCsrfToken } from "../security/auth.js";
import { store } from "../store.js";
import type { FlashMessage, UserRecord } from "../types.js";
import { config } from "../config.js";

export interface FlashBag {
  success?: FlashMessage;
  error?: FlashMessage;
  info?: FlashMessage;
}

type FlashFn = (kind: string, message?: string) => unknown;

export function readFlash(req: Request): FlashBag {
  const bag: FlashBag = {};
  const flashFn = (req as unknown as { flash: FlashFn }).flash;
  if (typeof flashFn !== "function") return bag;
  for (const kind of ["success", "error", "info"] as const) {
    const value = flashFn.call(req, kind);
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "string"
    ) {
      bag[kind] = { kind, text: value[0] };
    }
  }
  return bag;
}

export function flash(req: Request, kind: FlashMessage["kind"], text: string): void {
  const flashFn = (req as unknown as { flash: FlashFn }).flash;
  if (typeof flashFn === "function") flashFn.call(req, kind, text);
}

export interface CommonLocals {
  user: UserRecord | undefined;
  csrf: string;
  flash: FlashBag;
  siteName: string;
  siteTagline: string;
  unreadNotifications: number;
  path: string;
}

export async function commonLocals(req: Request, _res: Response): Promise<CommonLocals> {
  const csrf = issueCsrfToken(req);
  let unread = 0;
  if (req.user) {
    unread = await store.unreadNotificationCount(req.user.handle);
  }
  return {
    user: req.user,
    csrf,
    flash: readFlash(req),
    siteName: config.siteName,
    siteTagline: config.siteTagline,
    unreadNotifications: unread,
    path: req.path,
  };
}

/** 404 handler for unmatched routes. */
export function notFound(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).render("error", {
    pageTitle: "Page not found",
    message:
      "The page you're looking for doesn't exist… or moved, or was never here. Very 2004.",
    user: req.user ?? null,
    csrf: issueCsrfToken(req),
    siteName: config.siteName,
    siteTagline: config.siteTagline,
    unreadNotifications: 0,
    flash: {},
    path: req.path,
  });
}

export function serverError(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("[error]", req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).render("error", {
    pageTitle: "Something broke",
    message:
      "An internal error occurred. It's not you, it's us. The admins have been notified (well, the log file has).",
    user: req.user ?? null,
    csrf: issueCsrfToken(req),
    siteName: config.siteName,
    siteTagline: config.siteTagline,
    unreadNotifications: 0,
    flash: {},
    path: req.path,
  });
}
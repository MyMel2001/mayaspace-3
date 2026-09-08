/**
 * Express application assembly:
 *  - helmet security headers + strict CSP (no inline scripts, ever),
 *  - Fedify federation middleware (mounted before body parsers so activity
 *    requests are handled with their raw bodies for signature verification),
 *  - SQLite-backed sessions, flash messages, CSRF token issuance, auth loader,
 *  - /media serving for compressed upload files,
 *  - all feature routers + 404/500 handlers.
 *
 * `getFederation()` hands out a ready-to-use Fedify `Context` for out-of-band
 * deliveries (post fan-out, likes, follows) from anywhere in the app.
 */
import path from "node:path";
import express, { type Express } from "express";
import type { Context, Federation } from "@fedify/fedify";
import { integrateFederation } from "@fedify/express";
import expressFlash from "express-flash";
import { config } from "./config.js";
import { initFederation } from "./fediverse/federation.js";
import { generalLimiter, loadUser, sessionMiddleware } from "./security/auth.js";
import { securityHeaders } from "./security/csp.js";
import { notFound, serverError } from "./web/helpers.js";
import authRoutes from "./web/routes/auth.js";
import homeRoutes from "./web/routes/home.js";
import profileRoutes from "./web/routes/profile.js";
import postRoutes from "./web/routes/posts.js";
import friendRoutes from "./web/routes/friends.js";
import fediverseRoutes from "./web/routes/fediverse.js";
import notificationRoutes from "./web/routes/notifications.js";
import adminRoutes from "./web/routes/admin.js";

let federationInstance: Federation<unknown> | null = null;
let federationContext: Context<unknown> | null = null;

/**
 * Paths served by the federation dispatchers. Requests elsewhere skip the
 * fedify middleware entirely — wrapping every body via Readable.toWeb would
 * otherwise consume request streams that Express parsers (e.g. multer) still
 * need. (Fedify passes unmatched paths through via next(), but its request
 * wrapping leaves the stream drained.)
 */
const FEDIVERSE_PREFIXES = [
  "/users/",
  "/posts/",
  "/activities/",
  "/inbox",
  "/nodeinfo",
  "/.well-known/webfinger",
  "/.well-known/nodeinfo",
];

function isFediversePath(urlPath: string): boolean {
  return FEDIVERSE_PREFIXES.some((p) => urlPath === p || urlPath.startsWith(p));
}

/**
 * Returns a Context for outbound federation calls, or null while the
 * federation is not initialized yet. Safe to call from anywhere.
 */
export function getFederation(): Context<unknown> | null {
  if (federationContext !== null) return federationContext;
  if (federationInstance === null) return null;
  federationContext = federationInstance.createContext(new URL(config.mayaUrl), null);
  return federationContext;
}

/** Attachment filenames are machine-generated `<ts>-<uuid>.webp`. */
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

export interface AppHandle {
  app: Express;
  federation: Federation<unknown>;
}

export async function createApp(): Promise<AppHandle> {
  const federation = await initFederation();
  federationInstance = federation;

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);

  app.set("views", path.resolve("views"));
  app.set("view engine", "ejs");
  if (process.env.NODE_ENV === "production") app.set("view cache", true);

  // Security headers (CSP allows inline <style> for profile themes, never
  // inline <script>).
  app.use(securityHeaders());

  // Static assets + user-uploaded media.
  app.use(express.static(path.resolve("public"), { maxAge: "1h" }));
  app.get("/media/:name", (req, res) => {
    const name = String(req.params.name);
    if (!MEDIA_NAME_RE.test(name) || name.includes("..")) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(name, { root: config.uploadDir, dotfiles: "deny", maxAge: "30d", immutable: true });
  });

  // ActivityPub protocol endpoints — before body parsers, so fedify sees the
  // raw request body for HTTP signature verification. Non-AP requests bypass
  // the wrapper entirely (see isFediversePath above).
  const federationMiddleware = integrateFederation(federation, () => null);
  app.use((req, res, next) => {
    if (isFediversePath(req.path)) {
      federationMiddleware(req, res, next);
      return;
    }
    next();
  });

  // Body parsing, sessions, flash, auth.
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(sessionMiddleware());
  app.use(expressFlash());
  app.use(loadUser);
  app.use(generalLimiter);

  // Feature routers.
  app.use(homeRoutes);
  app.use(authRoutes);
  app.use(profileRoutes);
  app.use(postRoutes);
  app.use(friendRoutes);
  app.use(fediverseRoutes);
  app.use(notificationRoutes);
  app.use(adminRoutes);

  // 404 then 500.
  app.use(notFound);
  app.use(serverError);

  return { app, federation };
}
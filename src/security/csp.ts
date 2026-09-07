/**
 * Content-Security-Policy + helmet setup.
 *
 * 'unsafe-inline' styles: profile themes inject per-user <style> blocks — the
 * sanitizer makes those safe, so the policy allows inline <style> but NOT
 * inline scripts. Scripts are strictly external files only.
 */
import type { RequestHandler } from "express";
import helmet from "helmet";

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:", "http:"],
        "media-src": ["'self'", "https:", "http:"],
        "frame-src": [
          "'self'",
          "https://www.youtube.com",
          "https://www.youtube-nocookie.com",
          "https://player.vimeo.com",
          "https://www.dailymotion.com",
          "https://bandcamp.com",
          "https://w.soundcloud.com",
        ],
        "connect-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'self'"],
        "upgrade-insecure-requests": [],
      },
    },
    referrerPolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false, // allow embedding remote images
    crossOriginResourcePolicy: { policy: "same-site" },
  });
}
/**
 * Multer wiring for image uploads: memory storage (files are re-encoded by
 * sharp before touching disk), size/count limits from config, and friendly
 * redirect-on-error wrappers so MulterError never becomes a 500.
 */
import multer, { type MulterError } from "multer";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config.js";
import { flash } from "./helpers.js";

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadMb * 1024 * 1024,
    files: Math.max(1, config.attachmentsPerPost),
    fields: 20,
  },
});

function friendly(
  handler: RequestHandler,
  redirectTo: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err: unknown) => {
      if (err === undefined) {
        next();
        return;
      }
      const mErr = err as MulterError | undefined;
      console.error("[upload] multer error:", mErr?.code, mErr?.message ?? err);
      const msg =
        mErr?.code === "LIMIT_FILE_SIZE"
          ? `That file is larger than the ${config.maxUploadMb} MB limit.`
          : "Upload failed — try a smaller image.";
      flash(req, "error", msg);
      res.redirect(redirectTo);
    });
  };
}

/** Single "avatar" field → /settings. */
export const avatarUpload: RequestHandler = friendly(
  uploader.single("avatar"),
  "/settings",
);

/** Up to attachmentsPerPost "files" fields → composer. */
export const attachmentsUpload: RequestHandler = friendly(
  uploader.array("files", Math.max(1, config.attachmentsPerPost)),
  "/",
);
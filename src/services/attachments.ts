/**
 * Image uploads: validation, re-encode/compress with sharp (strips EXIF and
 * any malicious metadata chunks), thumbnail generation, and orphan cleanup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { AttachmentRecord, UserRecord } from "../types.js";
import { formatBytes, isoNow, newId } from "../util.js";
import sharp from "sharp";

const log = appLog("attachments");

const MAX_IMAGE_PIXELS = 24_000_000; // ~6000x4000 — sharp default DoS guard is lower

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const OUTPUT_MIME = "image/webp"; // everything is recompressed to WebP

export interface UploadResult {
  ok: boolean;
  error?: string;
  attachment?: AttachmentRecord;
}

/**
 * Processes one uploaded image:
 *  - verifies the declared MIME against an allowlist,
 *  - hard-checks the real dimensions/type via sharp metadata,
 *  - re-encodes to WebP (quality 80, capped dimensions) stripping metadata,
 *  - creates a 320px thumbnail,
 *  - stores both under uploadDir with random names.
 */
export async function processUpload(
  user: UserRecord,
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
): Promise<UploadResult> {
  if (!Object.hasOwn(MIME_EXT, file.mimetype)) {
    return { ok: false, error: "Only JPEG, PNG, WebP, GIF or AVIF images are allowed." };
  }
  if (file.buffer.length === 0) return { ok: false, error: "Empty file." };
  if (file.buffer.length > config.maxUploadMb * 1024 * 1024) {
    return { ok: false, error: `File is larger than ${config.maxUploadMb} MB.` };
  }

  let meta;
  try {
    meta = await sharp(file.buffer, { failOn: "warning" }).metadata();
  } catch {
    return { ok: false, error: "That file doesn't look like a valid image." };
  }
  if (!meta.width || !meta.height) return { ok: false, error: "Unable to read image dimensions." };
  if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
    return { ok: false, error: "Image dimensions are too large (max ~24 megapixels)." };
  }

  const id = newId();
  const base = `${Date.now()}-${id}`;
  const full = `${base}.webp`;
  const thumb = `${base}_thumb.webp`;

  try {
    const resized =
      meta.width > 2000 || meta.height > 2000
        ? sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside" })
        : sharp(file.buffer).rotate();

    const fullBuffer = await resized
      .toFormat("webp", { quality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    const thumbBuffer = await sharp(file.buffer)
      .rotate()
      .resize(320, 320, { fit: "cover" })
      .toFormat("webp", { quality: 75 })
      .toBuffer();

    await fs.writeFile(path.join(config.uploadDir, full), fullBuffer.data);
    await fs.writeFile(path.join(config.uploadDir, thumb), thumbBuffer);

    const att: AttachmentRecord = {
      id,
      postId: null,
      uploadedBy: user.handle,
      originalName: file.originalname.slice(0, 200),
      filename: full,
      thumbFilename: thumb,
      mime: OUTPUT_MIME,
      bytes: fullBuffer.data.length,
      width: fullBuffer.info.width,
      height: fullBuffer.info.height,
      createdAt: isoNow(),
    };
    await store.createAttachment(att);
    log.debug`Attachment ${id} stored (${formatBytes(fullBuffer.data.length)}) for ${user.handle}`;
    return { ok: true, attachment: att };
  } catch (err) {
    log.error`Upload processing failed: ${err}`;
    // best-effort cleanup of partially written files
    await fs.rm(path.join(config.uploadDir, full), { force: true }).catch(() => {});
    await fs.rm(path.join(config.uploadDir, thumb), { force: true }).catch(() => {});
    return { ok: false, error: "Couldn't process that image — it may be corrupt." };
  }
}

/** Deletes attachment files + record (used by orphan cleanup and moderation). */
export async function deleteAttachmentFiles(attachment: AttachmentRecord): Promise<void> {
  await fs.rm(path.join(config.uploadDir, attachment.filename), { force: true }).catch(() => {});
  await fs.rm(path.join(config.uploadDir, attachment.thumbFilename), { force: true }).catch(() => {});
  await store.deleteAttachment(attachment.id);
}

/** Removes orphaned (never attached) uploads older than the cutoff. */
export async function purgeOrphanAttachments(olderThanMs: number): Promise<number> {
  const orphans = await store.listOrphanAttachments(olderThanMs);
  for (const a of orphans) await deleteAttachmentFiles(a);
  if (orphans.length > 0) log.debug`Purged ${orphans.length} orphan attachment(s)`;
  return orphans.length;
}
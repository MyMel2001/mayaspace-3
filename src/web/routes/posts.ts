/**
 * Posting, single-post pages, comments, likes, attachments upload,
 * deletion. All POSTs are CSRF-guarded and rate-limited.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../../store.js";
import { buildCommentViews, buildPostViews } from "../../services/render.js";
import {
  createLocalComment,
  createLocalPost,
  deleteComment,
  deletePost,
} from "../../services/posts.js";
import { processUpload } from "../../services/attachments.js";
import { sendCreateNote, sendDeleteNote, sendRemoteLike } from "../../fediverse/federation.js";
import { getFederation } from "../../app.js";
import { attachmentsUpload } from "../upload.js";
import { csrfGuard, postLimiter, requireLogin, uploadLimiter } from "../../security/auth.js";
import { commonLocals, flash } from "../helpers.js";
import { config } from "../../config.js";

const router = Router();

// attachmentsUpload runs BEFORE the CSRF guard so multipart submissions (e.g.
// stale cached pages that still carry enctype="multipart/form-data" on the
// composer) get their body parsed and the embedded token verified. Urlencoded
// submissions pass through multer untouched; any files riding along directly
// are ignored — attachments are meant to arrive via the AJAX /uploads flow.
router.post("/posts", requireLogin, attachmentsUpload, csrfGuard, postLimiter, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body : "";
  const visibility = body.visibility === "friends" ? "friends" : "public";
  let attachmentIds: string[] = [];
  if (typeof body.attachments === "string" && body.attachments !== "") {
    attachmentIds = body.attachments.split(",").filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(
      0,
      config.attachmentsPerPost,
    );
  }
  const result = await createLocalPost(req.user!, text, { visibility, attachmentIds });
  if (!result.ok) {
    flash(req, "error", result.error ?? "Couldn't post.");
    res.redirect("/");
    return;
  }
  // Fan out to remote followers in the background (never blocks the render).
  const federation = getFederation();
  if (federation) {
    void sendCreateNote(federation, result.post!).catch((err) => {
      console.error("[posts] federation fan-out failed:", err);
    });
  }
  flash(req, "success", "Posted!");
  res.redirect(req.get("referer") ?? "/");
});

router.get("/post/:id", async (req: Request, res: Response) => {
  const post = await store.getPost(String(req.params.id));
  if (!post || post.deleted) {
    res.status(404).render("error", {
      ...(await commonLocals(req, res)),
      pageTitle: "Post not found",
      message: "This post has vanished into the void (or was deleted).",
    });
    return;
  }
  const [posts, comments] = await Promise.all([
    buildPostViews([post], req.user),
    buildCommentViews(await store.listComments(post.id), req.user),
  ]);
  res.render("post", {
    ...(await commonLocals(req, res)),
    pageTitle: "Post",
    postView: posts[0],
    comments,
  });
});

router.post(
  "/posts/:id/comment",
  requireLogin,
  csrfGuard,
  postLimiter,
  async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body : "";
    const result = await createLocalComment(req.user!, String(req.params.id), text);
    if (!result.ok) {
      flash(req, "error", result.error ?? "Couldn't comment.");
    }
    res.redirect(`/post/${String(req.params.id)}`);
  },
);

router.post("/posts/:id/delete", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const postId = String(req.params.id);
  const targetPost = await store.getPost(postId);
  const ok = await deletePost(req.user!.handle, req.user!.role, postId);
  if (!ok) {
    flash(req, "error", "Couldn't delete that post.");
  } else {
    const federation = getFederation();
    if (federation && targetPost && targetPost.authorType === "local" && targetPost.visibility === "public") {
      void sendDeleteNote(federation, targetPost).catch((err) => {
        console.error("[posts] federation delete fan-out failed:", err);
      });
    }
    flash(req, "info", "Post deleted.");
  }
  res.redirect("/");
});

router.post("/comments/:id/delete", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const comment = await store.getComment(String(req.params.id));
  if (!comment) {
    flash(req, "error", "Comment not found.");
    res.redirect("/");
    return;
  }
  await deleteComment(req.user!.handle, req.user!.role, comment.id);
  res.redirect(`/post/${comment.postId}`);
});

router.post("/posts/:id/like", requireLogin, csrfGuard, postLimiter, async (req: Request, res: Response) => {
  const post = await store.getPost(String(req.params.id));
  if (!post || post.deleted) {
    res.status(404).json({ error: "Post not found." });
    return;
  }
  const already = await store.hasLiked(post.id, req.user!.handle);
  if (already) {
    await store.unlikePost(post.id, req.user!.handle);
    if (post.authorType === "remote" && getFederation()) {
      void sendRemoteLike(getFederation()!, req.user!.handle, post, false).catch(() => {});
    }
  } else {
    await store.likePost(post.id, req.user!.handle, null);
    if (post.authorType === "remote" && getFederation()) {
      void sendRemoteLike(getFederation()!, req.user!.handle, post, true).catch(() => {});
    }
  }
  const count = await store.likeCount(post.id);
  res.json({ liked: !already, likeCount: count });
});

router.get("/uploads", requireLogin, (_req: Request, res: Response) => {
  res.render("error", {
    ...(res.locals ?? {}),
    pageTitle: "n/a",
    message: "Direct upload page not used.",
    user: res.locals.user,
  });
});

router.post(
  "/uploads",
  requireLogin,
  uploadLimiter,
  attachmentsUpload,
  csrfGuard,
  async (req: Request, res: Response) => {
    const files = (req as unknown as { files?: Express.Multer.File[] }).files ?? [];
    const results: Array<{ id: string; thumbUrl: string; name: string; bytes: number }> = [];
    for (const file of files.slice(0, config.attachmentsPerPost)) {
      const result = await processUpload(req.user!, file);
      if (result.ok && result.attachment) {
        results.push({
          id: result.attachment.id,
          thumbUrl: `/media/${result.attachment.thumbFilename}`,
          name: result.attachment.originalName,
          bytes: result.attachment.bytes,
        });
      }
    }
    res.json({ ok: results.length > 0, attachments: results });
  },
);

export default router;
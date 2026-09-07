/**
 * Admin/moderator panel: stats, user management (suspend/unsuspend/roles),
 * moderation log, blocked remote actors, scheduler control.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../../store.js";
import {
  blockRemoteActor,
  setRole,
  suspendUser,
  unblockRemoteActor,
  unsuspendUser,
} from "../../services/moderation.js";
import { csrfGuard, requireRole } from "../../security/auth.js";
import { runJobNow, schedulerStatus } from "../../scheduler.js";
import { commonLocals, flash } from "../helpers.js";

const router = Router();

router.get("/admin", requireRole("admin", "moderator"), async (req: Request, res: Response) => {
  const stats = await store.stats();
  const modLog = await store.listModLog(50);
  const blockedActors = (await store.listKnownRemoteActors(100)).filter((a) => a.suspended);
  res.render("admin", {
    ...(await commonLocals(req, res)),
    pageTitle: "Admin",
    stats,
    modLog,
    blockedActors: blockedActors.map((a) => ({ actorId: a.actorId, handle: a.handle })),
    jobs: schedulerStatus(),
    isAdmin: req.user!.role === "admin",
  });
});

router.post("/admin/suspend", requireRole("admin", "moderator"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const handle = String(body.handle ?? "").toLowerCase();
  const reason = typeof body.reason === "string" ? body.reason : "";
  const ok = await suspendUser(req.user!, handle, reason);
  flash(
    req,
    ok ? "success" : "error",
    ok ? `Suspended ${handle}.` : `Couldn't suspend ${handle} (missing or already suspended/admin).`,
  );
  res.redirect("/admin");
});

router.post("/admin/unsuspend", requireRole("admin", "moderator"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const handle = String(body.handle ?? "").toLowerCase();
  const ok = await unsuspendUser(req.user!, handle);
  flash(req, ok ? "success" : "error", ok ? `Unsuspended ${handle}.` : `Couldn't unsuspend ${handle}.`);
  res.redirect("/admin");
});

router.post("/admin/role", requireRole("admin"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const handle = String(body.handle ?? "").toLowerCase();
  const role = body.role === "moderator" ? "moderator" : body.role === "user" ? "user" : body.role === "admin" ? "admin" : null;
  if (role === null) {
    flash(req, "error", "Invalid role.");
    res.redirect("/admin");
    return;
  }
  const ok = await setRole(req.user!, handle, role);
  flash(req, ok ? "success" : "error", ok ? `${handle} is now ${role}.` : "Role change failed.");
  res.redirect("/admin");
});

router.post("/admin/delete-post", requireRole("admin", "moderator"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const postId = String(body.postId ?? "");
  const { moderateDeletePost } = await import("../../services/moderation.js");
  const ok = await moderateDeletePost(req.user!, postId);
  flash(req, ok ? "success" : "error", ok ? "Post removed." : "Post not found.");
  res.redirect("/admin");
});

router.post("/admin/block-remote", requireRole("admin", "moderator"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const actorId = String(body.actorId ?? "");
  const ok = await blockRemoteActor(req.user!, actorId);
  flash(req, ok ? "success" : "error", ok ? "Remote actor blocked." : "Couldn't block that actor.");
  res.redirect("/admin");
});

router.post("/admin/unblock-remote", requireRole("admin", "moderator"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const actorId = String(body.actorId ?? "");
  const ok = await unblockRemoteActor(req.user!, actorId);
  flash(req, ok ? "success" : "error", ok ? "Remote actor unblocked." : "Couldn't unblock.");
  res.redirect("/admin");
});

router.post("/admin/run-job", requireRole("admin"), csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const name = String(body.job ?? "");
  try {
    await runJobNow(name);
    flash(req, "success", `Job "${name}" completed.`);
  } catch (err) {
    flash(req, "error", `Job failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  res.redirect("/admin");
});

export default router;
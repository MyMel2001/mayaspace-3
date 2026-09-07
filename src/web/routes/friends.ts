/**
 * Friends page: request/accept/decline/remove, pending lists.
 */
import { Router, type Request, type Response } from "express";
import {
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  sendFriendRequest,
  topFriends,
} from "../../services/friends.js";
import { csrfGuard, requireLogin } from "../../security/auth.js";
import { store } from "../../store.js";
import { commonLocals, flash } from "../helpers.js";
import { timeAgo } from "../../util.js";

const router = Router();

router.get("/friends", requireLogin, async (req: Request, res: Response) => {
  const handle = req.user!.handle;
  const [incoming, outgoing] = await Promise.all([
    store.listPendingRequestsTo(handle),
    store.listPendingRequestsFrom(handle),
  ]);
  const friendRecords = await topFriends(handle, 50);
  const friends = [];
  for (const f of friendRecords) {
    friends.push({
      handle: f.handle,
      displayName: f.displayName,
      avatarUrl: f.avatar ? `/media/${f.avatar}` : null,
      top8: true,
    });
  }
  res.render("friends", {
    ...(await commonLocals(req, res)),
    pageTitle: "Friends",
    friends,
    incoming: incoming.map((r) => ({ id: r.id, handle: r.fromHandle, timeAgo: timeAgo(r.createdAt) })),
    outgoing: outgoing.map((r) => ({ id: r.id, handle: r.toHandle, timeAgo: timeAgo(r.createdAt) })),
  });
});

router.post("/friends/request", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const target = typeof body.handle === "string" ? body.handle : "";
  const result = await sendFriendRequest(req.user!, target);
  if (!result.ok) flash(req, "error", result.error);
  else flash(req, "success", `Friend request sent to ${target.toLowerCase()}.`);
  res.redirect(req.get("referer") ?? "/friends");
});

router.post("/friends/accept", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const result = await acceptFriendRequest(String(body.id ?? ""), req.user!);
  if (!result.ok) flash(req, "error", result.error);
  else flash(req, "success", "You're now friends!");
  res.redirect("/friends");
});

router.post("/friends/decline", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const result = await declineFriendRequest(String(body.id ?? ""), req.user!);
  if (!result.ok) flash(req, "error", result.error);
  else flash(req, "info", "Request declined.");
  res.redirect("/friends");
});

router.post("/friends/remove", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const other = String(body.handle ?? "").toLowerCase();
  await removeFriend(req.user!.handle, other);
  flash(req, "info", `Removed ${other} from your friends.`);
  res.redirect(req.get("referer") ?? "/friends");
});

export default router;
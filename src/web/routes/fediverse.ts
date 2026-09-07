/**
 * Fediverse bridging UI: remote actor lookup/profiles, follow/unfollow,
 * follow-request accept/reject, the local "fediverse" feed of mirrored
 * remote posts.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../../store.js";
import { buildPostViews } from "../../services/render.js";
import { ensureRemoteActor, resolveRemoteActor } from "../../fediverse/remote.js";
import { sendFollow, sendUnfollow } from "../../fediverse/federation.js";
import {
  acceptFediverseFollow,
  pendingFollowRequestViews,
  rejectFediverseFollow,
} from "../../services/fediverseFollows.js";
import { getFederation } from "../../app.js";
import { config } from "../../config.js";
import { csrfGuard, requireLogin } from "../../security/auth.js";
import { commonLocals, flash } from "../helpers.js";
import { escapeHtml, isoNow, newId, parseHttpUrl, stripHtml } from "../../util.js";
import { sanitizePostHtml } from "../../security/sanitize.js";
import type { PostRecord, RemoteActorRecord } from "../../types.js";

const router = Router();

router.get("/fediverse", async (req: Request, res: Response) => {
  // Mirrored remote posts feed.
  const posts = await store.remoteFeed(30);
  const views = await buildPostViews(posts, req.user);
  const remoteActors = await store.listKnownRemoteActors(20);
  // Inbound follow requests awaiting approval (shown on-page when logged in).
  const followRequests = req.user
    ? await pendingFollowRequestViews(req.user.handle)
    : [];
  res.render("fediverse", {
    ...(await commonLocals(req, res)),
    pageTitle: "Fediverse",
    posts: views,
    followRequests,
    remoteActors: remoteActors.map((a) => ({
      handle: a.handle,
      name: a.name ?? a.handle,
      avatarUrl: a.iconUrl,
      actorId: a.actorId,
      suspended: a.suspended,
    })),
  });
});

router.get("/fediverse/actor", async (req: Request, res: Response) => {
  const actorRef = typeof req.query.actor === "string" ? req.query.actor : "";
  if (actorRef === "") {
    res.redirect("/fediverse");
    return;
  }
  const federation = getFederation();
  const actor = federation
    ? await resolveRemoteActor(federation, actorRef)
    : await store.getRemoteActor(actorRef);
  if (!actor) {
    res.status(404).render("error", {
      ...(await commonLocals(req, res)),
      pageTitle: "Actor not found",
      message: "That fediverse account couldn't be resolved. Check the handle and try again.",
    });
    return;
  }
  const posts = await store.postsByRemoteActor(actor.actorId);
  const views = await buildPostViews(posts, req.user);
  const followRecord =
    req.user !== undefined ? await store.getRemoteFollow(req.user.handle, actor.actorId) : null;
  const following = followRecord !== null && followRecord !== undefined;
  res.render("remoteActor", {
    ...(await commonLocals(req, res)),
    pageTitle: actor.name ?? actor.handle,
    actor: {
      actorId: actor.actorId,
      handle: actor.handle,
      name: actor.name ?? actor.handle,
      bioHtml: actor.bioHtml,
      avatarUrl: actor.iconUrl,
      url: actor.url,
      suspended: actor.suspended,
    },
    posts: views,
    following,
  });
});

router.post("/fediverse/follow", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const actorRef = typeof body.actor === "string" ? body.actor : "";
  const federation = getFederation();
  if (!federation) {
    flash(req, "error", "Federation is not available right now.");
    res.redirect("/fediverse");
    return;
  }
  const remote: RemoteActorRecord | null = await ensureRemoteActor(
    federation,
    actorRef,
  );
  if (!remote) {
    flash(req, "error", "Couldn't find that fediverse account.");
    res.redirect("/fediverse");
    return;
  }
  if (remote.suspended) {
    flash(req, "error", "That account is blocked on this server.");
    res.redirect("/fediverse");
    return;
  }
  // Actors hosted on this instance (including yourself) are local users, not
  // fediverse accounts: following them over federation would just loop the
  // Follow back into our own inbox. Local users befriend each other with
  // friend requests instead.
  const ownHost = new URL(config.mayaUrl).host;
  if (parseHttpUrl(remote.actorId)?.host === ownHost) {
    flash(req, "error", "That's a MayaSpace user — send them a friend request instead.");
    res.redirect(req.get("referer") ?? "/fediverse");
    return;
  }
  const ok = await sendFollow(federation, req.user!.handle, remote);
  flash(
    req,
    ok ? "success" : "error",
    ok
      ? `Follow request sent to ${escapeHtml(remote.handle)}! It'll show up as "pending" until they respond.`
      : "Couldn't deliver the follow request.",
  );
  res.redirect(req.get("referer") ?? "/fediverse");
});

router.post("/fediverse/unfollow", requireLogin, csrfGuard, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const actorId = typeof body.actorId === "string" ? body.actorId : "";
  const federation = getFederation();
  const remote = await store.getRemoteActor(actorId);
  if (federation && remote) {
    await sendUnfollow(federation, req.user!.handle, remote);
    flash(req, "info", `Unfollowed ${escapeHtml(remote.handle)}.`);
  } else {
    // No cached actor record (dead server, wiped cache, key-migration debris):
    // still clear the local follow row so the entry can't strand forever.
    await store.deleteRemoteFollow(req.user!.handle, actorId);
    flash(req, "info", "Removed the follow — that account is no longer known to this server.");
  }
  res.redirect(req.get("referer") ?? "/fediverse");
});

router.post(
  "/fediverse/follow-requests/accept",
  requireLogin,
  csrfGuard,
  async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const actorId = typeof body.actorId === "string" ? body.actorId : "";
    const result = await acceptFediverseFollow(req.user!.handle, actorId);
    const remote = result.ok ? await store.getRemoteActor(actorId) : null;
    if (!result.ok) flash(req, "error", result.error);
    else flash(req, "success", `Approved — ${remote?.name ?? remote?.handle ?? "they"} now follows you.`);
    res.redirect(req.get("referer") ?? "/fediverse/follow-requests");
  },
);

router.post(
  "/fediverse/follow-requests/reject",
  requireLogin,
  csrfGuard,
  async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const actorId = typeof body.actorId === "string" ? body.actorId : "";
    const result = await rejectFediverseFollow(req.user!.handle, actorId);
    if (!result.ok) flash(req, "error", result.error);
    else flash(req, "info", "Follow request declined.");
    res.redirect(req.get("referer") ?? "/fediverse/follow-requests");
  },
);

/** The local user's queue of inbound fediverse follow requests. */
router.get("/fediverse/follow-requests", requireLogin, async (req: Request, res: Response) => {
  const requests = await pendingFollowRequestViews(req.user!.handle);
  res.render("followRequests", {
    ...(await commonLocals(req, res)),
    pageTitle: "Fediverse follow requests",
    requests,
  });
});

/** Remote-post mirroring entry point used when we fetch an unknown note URL. */
export async function mirrorRemoteNote(
  remote: RemoteActorRecord,
  apId: string,
  content: string,
  published: string | null,
  url: string | null,
): Promise<PostRecord> {
  const existing = await store.getPostByApId(apId);
  if (existing) return existing;
  const html = sanitizePostHtml(content);
  const post: PostRecord = {
    id: newId(),
    authorHandle: remote.handle,
    authorType: "remote",
    remoteActorId: remote.actorId,
    apId,
    url,
    html,
    textContent: stripHtml(html).slice(0, 500),
    visibility: "public",
    createdAt: published ?? isoNow(),
    attachmentIds: [],
    inReplyToApId: null,
    inReplyToLocalPostId: null,
    deleted: false,
  };
  await store.createPost(post);
  return post;
}

export default router;
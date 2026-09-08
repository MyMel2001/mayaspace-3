/**
 * Inbound fediverse follow requests: a remote actor's Follow lands in a
 * pending queue (the actor advertises manuallyApprovesFollowers); the local
 * user approves (Accept delivered back) or declines (Reject delivered back).
 * Outbound "I follow a remote actor" state lives in federation.ts instead.
 */
import { config } from "../config.js";
import { getFederation } from "../app.js";
import { sendFollowAccept, sendFollowReject } from "../fediverse/federation.js";
import { ensureRemoteActor } from "../fediverse/remote.js";
import { store } from "../store.js";
import type { FediverseFollowRecord, RemoteActorRecord } from "../types.js";
import { parseHttpUrl } from "../util.js";

export type FollowOutcome =
  | { ok: true }
  | { ok: false; error: string };

/** Approves a pending fediverse follow request. */
export async function acceptFediverseFollow(
  localHandle: string,
  remoteActorId: string,
): Promise<FollowOutcome> {
  const follow = await store.getFediverseFollow(localHandle, remoteActorId);
  if (!follow) return { ok: false, error: "Follow request not found — they may have unfollowed you." };
  if (follow.state === "active") return { ok: true };
  // A stale self-follow (the user's own actor IRI, possible from before the
  // follow route grew its own-instance guard) is bogus — just clear it.
  if (parseHttpUrl(remoteActorId)?.host === new URL(config.mayaUrl).host) {
    await store.deleteFediverseFollow(localHandle, remoteActorId);
    return { ok: true };
  }
  let remote = await store.getRemoteActor(remoteActorId);
  if (!remote) {
    // Cached actor record lost (key migration debris, wiped cache…) — try
    // one live re-resolve so a real follower isn't permanently stranded.
    const federation = getFederation();
    remote = federation ? await ensureRemoteActor(federation, remoteActorId) : null;
  }
  const federation = getFederation();
  if (!federation || !remote || follow.followActivityId === null) {
    return { ok: false, error: "Couldn't deliver approval. Try again after the remote account is reachable." };
  }
  if (!(await sendFollowAccept(federation, follow, remote))) {
    return { ok: false, error: "Couldn't deliver approval. The request is still pending; try again later." };
  }
  await store.setFediverseFollowState(localHandle, remoteActorId, "active");
  return { ok: true };
}

/** Declines a fediverse follow request and forgets it. */
export async function rejectFediverseFollow(
  localHandle: string,
  remoteActorId: string,
): Promise<FollowOutcome> {
  const follow = await store.getFediverseFollow(localHandle, remoteActorId);
  if (!follow) return { ok: false, error: "Follow request not found." };
  const remote = await store.getRemoteActor(remoteActorId);
  const federation = getFederation();
  // A Reject only makes sense when we kept the original Follow activity IRI.
  if (federation && remote && follow.followActivityId !== null) {
    await sendFollowReject(federation, follow, remote);
  }
  await store.deleteFediverseFollow(localHandle, remoteActorId);
  return { ok: true };
}

/** View-model shape for a fediverse follower / followee on profile pages. */
export interface FediverseConnectionView {
  name: string;
  handle: string;
  actorId: string;
  avatarUrl: string | null;
  profileUrl: string;
  isRemote: boolean;
  pending: boolean;
}

/** Derives a display handle ("user@host") from a raw actor IRI. */
function handleFromActorIri(actorId: string): string {
  try {
    const u = new URL(actorId);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return `${last.toLowerCase()}@${u.host}`;
  } catch {
    // not a URL — keep the raw ref
  }
  return actorId;
}

/**
 * Maps follow records to display entries (suspended actors are hidden).
 * Rows whose cached actor record is missing are NOT dropped: pending follow
 * requests would otherwise silently vanish from profile panels (badge counts
 * a request that renders nowhere, with no Accept/Decline buttons anywhere) —
 * exactly the "can't accept follow requests" bug. We fall back to an
 * IRI-derived stub view so the row stays visible and actionable.
 */
export async function connectionViewsFor(
  records: { remoteActorId: string; state: "pending" | "active" }[],
): Promise<{ views: FediverseConnectionView[]; total: number }> {
  const views: FediverseConnectionView[] = [];
  for (const f of records) {
    const a: RemoteActorRecord | null = await store.getRemoteActor(f.remoteActorId);
    if (a?.suspended) continue;
    if (a) {
      views.push({
        name: a.name ?? a.handle,
        handle: a.handle,
        actorId: a.actorId,
        avatarUrl: a.iconUrl,
        profileUrl: `/fediverse/actor?actor=${encodeURIComponent(a.actorId)}`,
        isRemote: true,
        pending: f.state === "pending",
      });
    } else {
      const fallbackHandle = handleFromActorIri(f.remoteActorId);
      views.push({
        name: fallbackHandle,
        handle: fallbackHandle,
        actorId: f.remoteActorId,
        avatarUrl: null,
        profileUrl: `/fediverse/actor?actor=${encodeURIComponent(f.remoteActorId)}`,
        isRemote: true,
        pending: f.state === "pending",
      });
    }
  }
  return { views, total: views.length };
}

/** Display shape for one pending inbound follow request row. */
export interface FollowRequestView {
  actorId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Builds the pending-follow-request list for the local user, shared by the
 * /fediverse page panel and the /fediverse/follow-requests queue so both
 * always agree. A request is NEVER dropped silently: if the cached actor
 * record is missing (e.g. an unreadable/legacy key), we attempt a live
 * re-resolve; failing that, we still render the row from the Follow activity
 * data we have (handle derived from the actor IRI) so pending requests
 * remain visible and actionable.
 */
export async function pendingFollowRequestViews(
  localHandle: string,
): Promise<FollowRequestView[]> {
  const pending = await store.listPendingFediverseFollowRequests(localHandle);
  const federation = getFederation();
  const views: FollowRequestView[] = [];
  for (const f of pending) {
    let a: RemoteActorRecord | null = await store.getRemoteActor(f.remoteActorId);
    if (!a && federation) {
      // Actor record unreadable — try re-fetching it from the network.
      a = await ensureRemoteActor(federation, f.remoteActorId);
    }
    if (a?.suspended) continue;
    if (a) {
      views.push({
        actorId: a.actorId,
        handle: a.handle,
        name: a.name ?? a.handle,
        avatarUrl: a.iconUrl,
      });
    } else {
      // Last resort: derive a display handle straight from the actor IRI
      // (e.g. "https://host/users/name" → "name@host") so the request
      // still shows up with working Accept/Decline buttons.
      let fallbackHandle = f.remoteActorId;
      try {
        const u = new URL(f.remoteActorId);
        const last = u.pathname.split("/").filter(Boolean).pop();
        if (last) fallbackHandle = `${last.toLowerCase()}@${u.host}`;
      } catch {
        // not a URL — keep the raw ref
      }
      views.push({
        actorId: f.remoteActorId,
        handle: fallbackHandle,
        name: fallbackHandle,
        avatarUrl: null,
      });
    }
  }
  return views;
}
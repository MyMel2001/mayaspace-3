/**
 * Inbound fediverse follow requests: a remote actor's Follow lands in a
 * pending queue (the actor advertises manuallyApprovesFollowers); the local
 * user approves (Accept delivered back) or declines (Reject delivered back).
 * Outbound "I follow a remote actor" state lives in federation.ts instead.
 */
import { getFederation } from "../app.js";
import { sendFollowAccept, sendFollowReject } from "../fediverse/federation.js";
import { store } from "../store.js";
import type { FediverseFollowRecord, RemoteActorRecord } from "../types.js";

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
  const remote = await store.getRemoteActor(remoteActorId);
  if (!remote) {
    return { ok: false, error: "That fediverse account is no longer known to this server." };
  }
  // Deliver Accept first so the remote starts treating the follow as live;
  // delivery failures are logged, not fatal (retry via re-follow).
  const federation = getFederation();
  if (federation && follow.followActivityId !== null) {
    await sendFollowAccept(federation, follow, remote);
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
  avatarUrl: string | null;
  profileUrl: string;
  isRemote: boolean;
  pending: boolean;
}

/** Maps follow records to display entries (suspended actors are hidden). */
export async function connectionViewsFor(
  records: { remoteActorId: string; state: "pending" | "active" }[],
): Promise<{ views: FediverseConnectionView[]; total: number }> {
  const views: FediverseConnectionView[] = [];
  for (const f of records) {
    const a: RemoteActorRecord | null = await store.getRemoteActor(f.remoteActorId);
    if (!a || a.suspended) continue;
    views.push({
      name: a.name ?? a.handle,
      handle: a.handle,
      avatarUrl: a.iconUrl,
      profileUrl: `/fediverse/actor?actor=${encodeURIComponent(a.actorId)}`,
      isRemote: true,
      pending: f.state === "pending",
    });
  }
  return { views, total: views.length };
}
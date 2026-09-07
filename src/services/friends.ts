/**
 * MySpace-style friends for LOCAL users: request → accept/decline → mutual
 * edge. Fediverse follows of remote actors live in fediverse.ts instead.
 */
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { UserRecord } from "../types.js";
import { isoNow, newId } from "../util.js";

const log = appLog("friends");

export type RequestOutcome =
  | { ok: true }
  | { ok: false; error: string };

export async function sendFriendRequest(
  from: UserRecord,
  toHandle: string,
): Promise<RequestOutcome> {
  const to = await store.getUser(toHandle.trim().toLowerCase());
  if (!to) return { ok: false, error: "No such user." };
  if (to.suspended) return { ok: false, error: "That user can't accept requests right now." };
  if (to.handle === from.handle) return { ok: false, error: "You can't befriend yourself (well, you can try)." };
  if (await store.isFriend(from.handle, to.handle)) {
    return { ok: false, error: "You're already friends." };
  }
  const pending = await store.listPendingRequestsFrom(from.handle);
  if (pending.some((r) => r.toHandle === to.handle)) {
    return { ok: false, error: "Request already sent." };
  }
  // If they already requested YOU, auto-accept instead of queueing a new one.
  const incoming = (await store.listPendingRequestsTo(from.handle)).find(
    (r) => r.fromHandle === to.handle,
  );
  if (incoming) {
    await acceptFriendRequest(incoming.id, from);
    return { ok: true };
  }
  await store.createFriendRequest({
    id: newId(),
    fromHandle: from.handle,
    toHandle: to.handle,
    createdAt: isoNow(),
    status: "pending",
  });
  await store.createNotification({
    toHandle: to.handle,
    type: "friend_request",
    actorHandle: from.handle,
    remoteActorId: null,
    postId: null,
    commentId: null,
    message: `${from.displayName} wants to be your friend!`,
  });
  log.debug`Friend request ${from.handle} -> ${to.handle}`;
  return { ok: true };
}

export async function acceptFriendRequest(
  requestId: string,
  toUser: UserRecord,
): Promise<RequestOutcome> {
  const req = await store.getFriendRequest(requestId);
  if (!req || req.status !== "pending") return { ok: false, error: "Request not found." };
  if (req.toHandle !== toUser.handle) return { ok: false, error: "Not your request." };
  const from = await store.getUser(req.fromHandle);
  if (!from || from.suspended) return { ok: false, error: "User no longer available." };
  await store.updateFriendRequest(requestId, { status: "accepted" });
  await store.addFriendEdge(req.fromHandle, req.toHandle);
  await store.createNotification({
    toHandle: req.fromHandle,
    type: "friend_accept",
    actorHandle: toUser.handle,
    remoteActorId: null,
    postId: null,
    commentId: null,
    message: `${toUser.displayName} accepted your friend request!`,
  });
  log.debug`Friend request accepted: ${req.fromHandle} <-> ${req.toHandle}`;
  return { ok: true };
}

export async function declineFriendRequest(
  requestId: string,
  toUser: UserRecord,
): Promise<RequestOutcome> {
  const req = await store.getFriendRequest(requestId);
  if (!req || req.toHandle !== toUser.handle) return { ok: false, error: "Request not found." };
  await store.updateFriendRequest(requestId, { status: "declined" });
  return { ok: true };
}

export async function removeFriend(handle: string, other: string): Promise<void> {
  await store.removeFriendEdge(handle, other);
}

export async function topFriends(handle: string, limit = 8): Promise<UserRecord[]> {
  const handles = await store.listFriends(handle);
  const users: UserRecord[] = [];
  for (const h of handles) {
    const u = await store.getUser(h);
    if (u && !u.suspended) users.push(u);
    if (users.length >= limit) break;
  }
  return users;
}
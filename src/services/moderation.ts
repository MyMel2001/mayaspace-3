/**
 * Moderation: suspension, content removal, remote-actor blocking, mod log.
 * Admins and moderators (from ADMIN_HANDLES / MODERATOR_HANDLES) act here.
 */
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { UserRecord } from "../types.js";

const log = appLog("moderation");

export async function suspendUser(moderator: UserRecord, handle: string, reason: string): Promise<boolean> {
  const user = await store.getUser(handle);
  if (!user || user.suspended) return false;
  if (user.role === "admin") return false; // admins can't be suspended
  await store.updateUser(handle, {
    suspended: true,
    suspendReason: reason.slice(0, 200) || "No reason given.",
  });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "suspend",
    target: `user:${handle}`,
    details: reason.slice(0, 200),
  });
  log.info`${moderator.handle} suspended ${handle}`;
  return true;
}

export async function unsuspendUser(moderator: UserRecord, handle: string): Promise<boolean> {
  const user = await store.getUser(handle);
  if (!user || !user.suspended) return false;
  await store.updateUser(handle, { suspended: false, suspendReason: null });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "unsuspend",
    target: `user:${handle}`,
    details: "",
  });
  log.info`${moderator.handle} unsuspended ${handle}`;
  return true;
}

export async function setRole(moderator: UserRecord, handle: string, role: UserRecord["role"]): Promise<boolean> {
  const user = await store.getUser(handle);
  if (!user) return false;
  if (moderator.role !== "admin") return false; // only admins reassign roles
  await store.updateUser(handle, { role });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "set_role",
    target: `user:${handle}`,
    details: role,
  });
  log.info`${moderator.handle} set role of ${handle} to ${role}`;
  return true;
}

/** Moderators can delete any local post; the author attribution is kept. */
export async function moderateDeletePost(
  moderator: UserRecord,
  postId: string,
): Promise<boolean> {
  const post = await store.getPost(postId);
  if (!post || post.deleted) return false;
  await store.updatePost(postId, { deleted: true });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "delete_post",
    target: `post:${postId}`,
    details: post.textContent.slice(0, 100),
  });
  log.info`${moderator.handle} deleted post ${postId}`;
  return true;
}

export async function moderateDeleteComment(moderator: UserRecord, commentId: string): Promise<boolean> {
  const comment = await store.getComment(commentId);
  if (!comment || comment.deleted) return false;
  await store.updateComment(commentId, { deleted: true });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "delete_comment",
    target: `comment:${commentId}`,
    details: comment.html.slice(0, 100),
  });
  return true;
}

/** Blocks a remote actor: their content is hidden for everyone locally. */
export async function blockRemoteActor(moderator: UserRecord, actorId: string): Promise<boolean> {
  const actor = await store.getRemoteActor(actorId);
  if (!actor || actor.suspended) return false;
  await store.upsertRemoteActor({ ...actor, suspended: true });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "block_remote",
    target: `remote:${actorId}`,
    details: actor.handle,
  });
  log.info`${moderator.handle} blocked remote actor ${actorId}`;
  return true;
}

export async function unblockRemoteActor(moderator: UserRecord, actorId: string): Promise<boolean> {
  const actor = await store.getRemoteActor(actorId);
  if (!actor || !actor.suspended) return false;
  await store.upsertRemoteActor({ ...actor, suspended: false });
  await store.addModLog({
    actorHandle: moderator.handle,
    action: "unblock_remote",
    target: `remote:${actorId}`,
    details: actor.handle,
  });
  return true;
}

export async function purgeRemoteContent(actorId: string): Promise<void> {
  const posts = await store.postsByRemoteActor(actorId);
  for (const p of posts) {
    await store.updatePost(p.id, { deleted: true });
  }
}
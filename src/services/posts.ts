/**
 * Post + comment creation. Handles mention extraction, notification fan-out
 * to friends/mentions, attachment binding, and remote-post mirroring.
 */
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { PostRecord, UserRecord, Visibility } from "../types.js";
import { escapeHtml, isoNow, newId, parseRemoteHandle } from "../util.js";
import { sanitizePostHtml, sanitizeTextHtml } from "../security/sanitize.js";
import { rawTextToHtml } from "./render.js";

const log = appLog("posts");

export interface CreatePostResult {
  ok: boolean;
  error?: string;
  post?: PostRecord;
  mentionedHandles: string[];
}

/**
 * Creates a local post. `rawHtml` has already been through the rich-text
 * sanitizer; mentions (@handle) are detected on the plain-text form.
 */
export async function createLocalPost(
  author: UserRecord,
  rawText: string,
  opts: {
    visibility: Visibility;
    attachmentIds?: string[];
  },
): Promise<CreatePostResult> {
  const text = rawText.trim();
  const attachmentIds: string[] = [];
  for (const attId of opts.attachmentIds?.slice(0, config.attachmentsPerPost) ?? []) {
    const att = await store.getAttachment(attId);
    if (att && att.uploadedBy === author.handle && att.postId === null) attachmentIds.push(attId);
  }
  if (text === "" && attachmentIds.length === 0) {
    return { ok: false, error: "Say something or attach an image first!", mentionedHandles: [] };
  }
  if (text.length > config.postMaxChars) {
    return {
      ok: false,
      error: `Post is too long (${text.length} > ${config.postMaxChars} characters).`,
      mentionedHandles: [],
    };
  }
  const mentionedHandles = await resolveLocalMentions(extractLocalMentions(text));
  const html = sanitizePostHtml(linkLocalMentions(rawTextToHtml(text), mentionedHandles));

  const post: PostRecord = {
    id: newId(),
    authorHandle: author.handle,
    authorType: "local",
    remoteActorId: null,
    apId: null,
    url: null,
    html,
    textContent: text,
    visibility: opts.visibility,
    createdAt: isoNow(),
    attachmentIds: [],
    inReplyToApId: null,
    inReplyToLocalPostId: null,
    deleted: false,
  };
  await store.createPost(post);

  if (attachmentIds.length > 0) {
    const attachedIds: string[] = [];
    for (const attId of attachmentIds) {
      if (await store.updateAttachmentPost(attId, post.id)) attachedIds.push(attId);
    }
    post.attachmentIds = attachedIds;
    await store.updatePost(post.id, { attachmentIds: attachedIds });
  }

  // Notify friends + mentioned users.
  const friendHandles = await store.listFriends(author.handle);
  const notified = new Set<string>();
  for (const friend of friendHandles) {
    notified.add(friend);
    await store.createNotification({
      toHandle: friend,
      type: "comment", // reuse: "new post from friend" — displayed generically
      actorHandle: author.handle,
      remoteActorId: null,
      postId: post.id,
      commentId: null,
      message: `${author.displayName} posted: ${escapeHtml(post.textContent.slice(0, 60))}`,
    });
  }
  for (const m of mentionedHandles) {
    if (notified.has(m) || m === author.handle) continue;
    notified.add(m);
    await store.createNotification({
      toHandle: m,
      type: "mention",
      actorHandle: author.handle,
      remoteActorId: null,
      postId: post.id,
      commentId: null,
      message: `${author.displayName} mentioned you in a post.`,
    });
  }

  log.debug`Local post created by ${author.handle}: ${post.id}`;
  return { ok: true, post, mentionedHandles };
}

/** Turns verified local @mentions into profile links before HTML sanitization. */
function linkLocalMentions(html: string, handles: string[]): string {
  const mentioned = new Set(handles);
  return html.replace(/@([a-z0-9_]{3,20})\b/gi, (whole, rawHandle: string) => {
    const handle = rawHandle.toLowerCase();
    return mentioned.has(handle) ? `<a href="/u/${handle}">${whole}</a>` : whole;
  });
}

/** @mentions of LOCAL users — pattern: @handle with valid handle chars. */
export function extractLocalMentions(text: string): string[] {
  const found = new Set<string>();
  const re = /@([a-z0-9_]{3,20})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
  }
  const existing: string[] = [];
  for (const h of found) {
    if (existing.length >= 10) break;
    // existence checked by caller via store
    existing.push(h);
  }
  return existing;
}

/** Filters mention list down to handles that actually exist locally. */
export async function resolveLocalMentions(handles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of handles) {
    if (await store.handleExists(h)) out.push(h);
  }
  return out;
}

export interface CreateCommentResult {
  ok: boolean;
  error?: string;
  comment?: {
    id: string;
    html: string;
    createdAt: string;
    postId: string;
  };
}

export async function createLocalComment(
  author: UserRecord,
  postId: string,
  rawText: string,
): Promise<CreateCommentResult> {
  const text = rawText.trim();
  if (text === "") return { ok: false, error: "Comment can't be empty." };
  if (text.length > config.commentMaxChars) {
    return { ok: false, error: `Comment too long (max ${config.commentMaxChars} characters).` };
  }
  const post = await store.getPost(postId);
  if (!post || post.deleted) return { ok: false, error: "Post not found." };
  const html = post.visibility === "friends" ? sanitizeTextHtml(rawTextToHtml(text)) : sanitizePostHtml(rawTextToHtml(text));
  const commentId = newId();
  await store.createComment({
    id: commentId,
    postId,
    authorHandle: author.handle,
    authorType: "local",
    remoteActorId: null,
    apId: null,
    html,
    createdAt: isoNow(),
    deleted: false,
  });
  if (post.authorType === "local" && post.authorHandle !== author.handle) {
    await store.createNotification({
      toHandle: post.authorHandle,
      type: "comment",
      actorHandle: author.handle,
      remoteActorId: null,
      postId,
      commentId,
      message: `${author.displayName} commented on your post.`,
    });
  }
  // Mention notifications in comments.
  for (const m of await resolveLocalMentions(extractLocalMentions(text))) {
    if (m === author.handle || m === post.authorHandle) continue;
    await store.createNotification({
      toHandle: m,
      type: "mention",
      actorHandle: author.handle,
      remoteActorId: null,
      postId,
      commentId,
      message: `${author.displayName} mentioned you in a comment.`,
    });
  }
  log.debug`Comment by ${author.handle} on ${postId}`;
  return { ok: true, comment: { id: commentId, html, createdAt: isoNow(), postId } };
}

export async function deletePost(handle: string, role: UserRecord["role"], postId: string): Promise<boolean> {
  const post = await store.getPost(postId);
  if (!post || post.deleted) return false;
  if (post.authorHandle !== handle && role !== "admin" && role !== "moderator") return false;
  await store.updatePost(postId, { deleted: true });
  log.info`Post ${postId} deleted (by ${handle}, role ${role})`;
  return true;
}

export async function deleteComment(handle: string, role: UserRecord["role"], commentId: string): Promise<boolean> {
  const comment = await store.getComment(commentId);
  if (!comment || comment.deleted) return false;
  if (comment.authorHandle !== handle && role !== "admin" && role !== "moderator") return false;
  await store.updateComment(commentId, { deleted: true });
  log.info`Comment ${commentId} deleted (by ${handle})`;
  return true;
}

export function isRemoteMention(text: string): boolean {
  return parseRemoteHandle(text.replace(/^[^\w@]*@?/, "")) !== null && /@/.test(text);
}
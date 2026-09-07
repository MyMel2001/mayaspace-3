/**
 * Rendering pipeline: converts raw user text into safe display HTML,
 * builds PostView/CommentView models with author + attachment + embed data.
 */
import { config } from "../config.js";
import { store } from "../store.js";
import type {
  AttachmentRecord,
  AttachmentView,
  AuthorView,
  CommentRecord,
  CommentView,
  PostRecord,
  PostView,
  Role,
} from "../types.js";
import { escapeHtml, stripHtml, timeAgo } from "../util.js";
import { findEmbeds } from "./embeds.js";

export function attachmentView(a: AttachmentRecord): AttachmentView {
  return {
    id: a.id,
    url: `/media/${a.filename}`,
    thumbUrl: `/media/${a.thumbFilename}`,
    width: a.width,
    height: a.height,
    mime: a.mime,
    bytes: a.bytes,
  };
}

export async function authorViewForLocal(handle: string): Promise<AuthorView> {
  const u = await store.getUser(handle);
  return {
    handle,
    displayName: u?.displayName ?? handle,
    avatarUrl: u?.avatar ? `/media/${u.avatar}` : null,
    profileUrl: `/u/${handle}`,
    isRemote: false,
  };
}

export function authorViewForRemote(record: {
  actorId: string;
  handle: string;
  name: string | null;
  iconUrl: string | null;
}): AuthorView {
  return {
    handle: record.handle,
    displayName: record.name ?? record.handle,
    avatarUrl: record.iconUrl,
    profileUrl: `/fediverse/actor?actor=${encodeURIComponent(record.actorId)}`,
    isRemote: true,
  };
}

/** Converts raw textarea content to sanitized HTML (newlines -> <br>). */
export function rawTextToHtml(raw: string): string {
  const cleaned = raw.replace(/\r\n/g, "\n").trim();
  const withBreaks = cleaned.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
  return `<p>${withBreaks}</p>`;
}

function canLike(user: { role: Role; suspended: boolean } | undefined): boolean {
  return user !== undefined && !user.suspended;
}

export async function buildPostViews(
  records: PostRecord[],
  viewer: { handle: string; role: Role; suspended: boolean } | undefined,
): Promise<PostView[]> {
  const likeCounts = await store.likeCountsFor(records.map((r) => r.id));
  const views: PostView[] = [];
  for (const post of records) {
    const commentCount = await store.countComments(post.id);
    const likeCount = likeCounts.get(post.id) ?? 0;
    const likedByMe = viewer ? await store.hasLiked(post.id, viewer.handle) : false;

    let author: AuthorView;
    if (post.authorType === "remote" && post.remoteActorId) {
      const ra = await store.getRemoteActor(post.remoteActorId);
      author = ra
        ? authorViewForRemote(ra)
        : {
            handle: post.authorHandle,
            displayName: post.authorHandle,
            avatarUrl: null,
            profileUrl: "#",
            isRemote: true,
          };
    } else {
      author = await authorViewForLocal(post.authorHandle);
    }

    const attachments = await store.listAttachments(post.id);
    const embeds = findEmbeds(post.html);

    views.push({
      id: post.id,
      author,
      html: post.html,
      embeds,
      attachments: attachments.map(attachmentView),
      createdAtIso: post.createdAt,
      timeAgo: timeAgo(post.createdAt),
      permalink: `/post/${post.id}`,
      remoteUrl: post.url,
      visibility: post.visibility,
      likeCount,
      commentCount,
      likedByMe,
      canLike: canLike(viewer),
      canDelete:
        viewer !== undefined &&
        (post.authorHandle === viewer.handle || viewer.role === "admin" || viewer.role === "moderator"),
      canModerate: viewer !== undefined && (viewer.role === "admin" || viewer.role === "moderator"),
      isRemote: post.authorType === "remote",
      apId: post.apId,
    });
  }
  return views;
}

export async function buildCommentViews(
  records: CommentRecord[],
  viewer: { handle: string; role: Role; suspended: boolean } | undefined,
): Promise<CommentView[]> {
  const views: CommentView[] = [];
  for (const c of records) {
    let author: AuthorView;
    if (c.authorType === "remote" && c.remoteActorId) {
      const ra = await store.getRemoteActor(c.remoteActorId);
      author = ra
        ? authorViewForRemote(ra)
        : {
            handle: c.authorHandle,
            displayName: c.authorHandle,
            avatarUrl: null,
            profileUrl: "#",
            isRemote: true,
          };
    } else {
      author = await authorViewForLocal(c.authorHandle);
    }
    views.push({
      id: c.id,
      author,
      html: c.html,
      createdAtIso: c.createdAt,
      timeAgo: timeAgo(c.createdAt),
      canDelete:
        viewer !== undefined &&
        (c.authorHandle === viewer.handle || viewer.role === "admin" || viewer.role === "moderator"),
      isRemote: c.authorType === "remote",
    });
  }
  return views;
}

/** Truncated, tag-free preview text for lists/meta descriptions. */
export function previewText(html: string, max = 140): string {
  const text = stripHtml(html);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export { escapeHtml };

export const postLimits = {
  maxChars: config.postMaxChars,
  attachments: config.attachmentsPerPost,
};
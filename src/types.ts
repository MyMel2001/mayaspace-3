/**
 * Shared domain + view-model types for MayaSpace, plus session augmentation.
 */
import "express-session";

export type Role = "user" | "moderator" | "admin";

/** A locally-registered MayaSpace user. */
export interface UserRecord {
  id: string;
  handle: string; // lowercase, unique, immutable
  displayName: string; // raw text; escaped at render time
  email: string | null;
  passwordHash: string; // scrypt:<salt>:<hash>
  role: Role;
  suspended: boolean;
  suspendReason: string | null;
  bioHtml: string; // sanitized HTML
  avatar: string | null; // filename under uploadDir
  themeColor: string; // hex like "#3b5998" or ""
  customCss: string; // sanitized CSS
  createdAt: string; // ISO
  lastLogin: string | null;
}

/** An actor from another fediverse server that we've cached. */
export interface RemoteActorRecord {
  actorId: string; // canonical IRI, primary key
  handle: string; // username@host (best effort)
  name: string | null;
  bioHtml: string; // sanitized HTML
  iconUrl: string | null;
  inbox: string;
  sharedInbox: string | null;
  outbox: string | null;
  url: string | null; // HTML profile URL, if advertised
  isBot: boolean;
  createdAt: string;
  suspended: boolean; // local moderation flag — hides their content
}

export type Visibility = "public" | "friends";

/** A post: either authored locally or mirrored from a remote actor. */
export interface PostRecord {
  id: string; // UUID; for remote posts an internally-generated UUID
  authorHandle: string; // local handle, or username@host for remote authors
  authorType: "local" | "remote";
  remoteActorId: string | null; // set for remote posts
  apId: string | null; // canonical ActivityPub IRI of a remote note
  url: string | null; // remote HTML URL, if advertised
  html: string; // sanitized HTML
  textContent: string; // plain text for search/previews
  visibility: Visibility;
  createdAt: string; // ISO
  attachmentIds: string[];
  inReplyToApId: string | null; // remote thread linking
  inReplyToLocalPostId: string | null; // remote reply to a local post
  deleted: boolean;
}

/** A comment on a post, local or remote. */
export interface CommentRecord {
  id: string; // UUID
  postId: string; // local post id it belongs to
  authorHandle: string;
  authorType: "local" | "remote";
  remoteActorId: string | null;
  apId: string | null;
  html: string; // sanitized
  createdAt: string; // ISO
  deleted: boolean;
}

/** A processed uploaded image. */
export interface AttachmentRecord {
  id: string; // UUID
  postId: string | null; // null until attached to a post
  uploadedBy: string; // local handle
  originalName: string; // client-provided name (untrusted, display only)
  filename: string; // stored full-size file
  thumbFilename: string; // stored thumbnail
  mime: string; // always an image/* allowlisted type
  bytes: number; // processed file size
  width: number;
  height: number;
  createdAt: string;
}

/** MySpace-style friend request between two LOCAL users. */
export interface FriendRequestRecord {
  id: string;
  fromHandle: string;
  toHandle: string;
  createdAt: string;
  status: "pending" | "accepted" | "declined";
}

/** Mutual friendship edge between two LOCAL users. */
export interface FriendEdgeRecord {
  id: string; // sorted-pair id "a|b"
  a: string; // lexically smaller handle
  b: string; // lexically larger handle
  createdAt: string;
}

/** A local user following a remote actor (outbound fediverse follow). */
export interface RemoteFollowRecord {
  id: string; // "<localHandle>|<remoteActorId>"
  localHandle: string;
  remoteActorId: string;
  state: "pending" | "active";
  followActivityId: string | null; // IRI of our Follow activity (dereferenceable via /activities/{id})
  createdAt: string;
}

/** A remote actor following a local user (inbound fediverse follow). */
export interface FediverseFollowRecord {
  id: string; // "in|<remoteActorId>|<localHandle>"
  localHandle: string; // the followed local user
  remoteActorId: string; // the remote follower
  state: "pending" | "active"; // pending = awaiting local approval
  followActivityId: string | null; // IRI of the original Follow activity (for Accept/Reject)
  createdAt: string;
}

export type NotificationType =
  | "friend_request"
  | "friend_accept"
  | "comment"
  | "like"
  | "comment_like"
  | "remote_follow"
  | "remote_follow_request"
  | "remote_accept"
  | "mention";

export interface NotificationRecord {
  id: string;
  toHandle: string;
  type: NotificationType;
  actorHandle: string | null; // local actor
  remoteActorId: string | null; // remote actor
  postId: string | null;
  commentId: string | null;
  message: string | null;
  read: boolean;
  createdAt: string;
}

export interface ModerationLogRecord {
  id: string;
  actorHandle: string; // moderator/admin who performed the action
  action: string;
  target: string; // e.g. "user:alice", "post:<uuid>", "remote:<iri>"
  details: string;
  createdAt: string;
}

/** Minimal user identity stored inside the express-session cookie store. */
export interface SessionUser {
  id: string;
  handle: string;
  role: Role;
}

// ── View models handed to EJS templates ─────────────────────────────────────

export interface FlashMessage {
  kind: "success" | "error" | "info";
  text: string;
}

export interface AuthorView {
  handle: string; // local handle or user@host
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string; // internal HTML link
  isRemote: boolean;
}

export interface AttachmentView {
  id: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
}

export interface EmbedView {
  provider: string; // "YouTube", "Vimeo", "Image"
  html: string; // trusted, server-generated markup
}

export interface CommentView {
  id: string;
  author: AuthorView;
  html: string;
  createdAtIso: string;
  timeAgo: string;
  canDelete: boolean;
  isRemote: boolean;
}

export interface PostView {
  id: string;
  author: AuthorView;
  html: string;
  embeds: EmbedView[];
  attachments: AttachmentView[];
  createdAtIso: string;
  timeAgo: string;
  permalink: string;
  remoteUrl: string | null;
  visibility: Visibility;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  canLike: boolean;
  canDelete: boolean;
  canModerate: boolean;
  isRemote: boolean;
  apId: string | null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  message: string;
  link: string;
  timeAgo: string;
  read: boolean;
  actor: AuthorView | null;
}

export interface PagePostData {
  posts: PostView[];
  nextCursor: string | null;
}

export interface LikeRecord {
  id: string; // "<postId>:<liker>" composite key
  postId: string;
  liker: string; // local handle, or remote:<actorId> / boost:<actorId> for remote
  remoteActorId: string | null;
  createdAt: string;
}

export interface CommentLikeRecord {
  id: string; // "<commentId>:<liker>"
  commentId: string;
  liker: string;
  remoteActorId: string | null;
  createdAt: string;
}

// Session payload shape (cookie/session store).
declare module "express-session" {
  interface SessionData {
    userId?: string;
    handle?: string;
    csrfToken?: string;
    returnTo?: string;
  }
}
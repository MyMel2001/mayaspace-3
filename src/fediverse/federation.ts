/**
 * The ActivityPub federation core, built on Fedify:
 *  - actor/object dispatchers serving Person + Note documents,
 *  - followers/following/outbox collections,
 *  - inbox listeners: Follow, Create, Like, Announce, Undo, Delete, Update,
 *  - outbound helpers: follow/unfollow, Create/Note fan-out, Like/Undo,
 *    Delete for moderation.
 */
import { createFederationBuilder } from "@fedify/fedify";
import type { Context, RequestContext } from "@fedify/fedify";
import {
  Accept,
  Announce,
  Create,
  Delete,
  Follow,
  Image,
  Like,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Reject,
  Service,
  Tombstone,
  Undo,
  Update,
} from "@fedify/vocab";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store, Store } from "../store.js";
import type { FediverseFollowRecord, PostRecord, RemoteActorRecord } from "../types.js";
import { isoNow, newId, stripHtml } from "../util.js";
import { sanitizePostHtml } from "../security/sanitize.js";
import { getActorKeyPairs } from "./keys.js";
import { resolveRemoteActor } from "./remote.js";

const log = appLog("fediverse.federation");

export function actorIdFor(handle: string): URL {
  return new URL(`${config.mayaUrl}/users/${encodeURIComponent(handle)}`);
}

export function noteIdFor(postId: string): URL {
  return new URL(`${config.mayaUrl}/posts/${encodeURIComponent(postId)}`);
}

function toInstant(iso: string): Temporal.Instant {
  return Temporal.Instant.from(iso);
}

// ── actor dispatcher ─────────────────────────────────────────────────────────

/**
 * The instance service actor ("MayaSpace") signs all outbound document
 * fetches; servers with authorized fetch dereference its keyId to verify
 * signatures, so it must be publicly served like any other actor.
 */
const SERVICE_ACTOR_HANDLE = "mayaspace";

const actorDispatcher = async (
  ctx: RequestContext<unknown>,
  identifier: string,
): Promise<Person | Service | Tombstone | null> => {
  const handle = decodeURIComponent(identifier).toLowerCase();

  if (handle === SERVICE_ACTOR_HANDLE) {
    // Touch the key pairs so they exist before anyone signs/verifies.
    await getActorKeyPairs(handle);
    const actorId = ctx.getActorUri(handle);
    return new Service({
      id: actorId,
      name: config.siteName,
      preferredUsername: "MayaSpace",
      inbox: ctx.getInboxUri(handle),
      outbox: ctx.getOutboxUri(handle),
      url: new URL(config.mayaUrl),
      manuallyApprovesFollowers: true,
      summary: `Official service actor for ${config.siteName} (${config.mayaUrl}).`,
    });
  }

  const user = await store.getUser(handle);
  if (!user || user.suspended) return null;

  // Touch the key pairs so they exist before anyone signs/verifies.
  await getActorKeyPairs(handle);

  const actorId = ctx.getActorUri(handle);
  const icon: Image | null = user.avatar
    ? new Image({
        url: new URL(`${config.mayaUrl}/media/${user.avatar}`),
        mediaType: "image/webp",
      })
    : null;

  const person = new Person({
    id: actorId,
    name: user.displayName,
    preferredUsername: handle,
    inbox: ctx.getInboxUri(handle),
    outbox: ctx.getOutboxUri(handle),
    followers: ctx.getFollowersUri(handle),
    following: ctx.getFollowingUri(handle),
    liked: ctx.getLikedUri(handle),
    url: new URL(`${config.mayaUrl}/u/${handle}`),
    summary: user.bioHtml === "" ? null : user.bioHtml,
    manuallyApprovesFollowers: true,
    published: toInstant(user.createdAt),
    icon,
  });
  return person;
};

// ── object dispatcher for notes ──────────────────────────────────────────────

const noteDispatcher = async (
  ctx: RequestContext<unknown>,
  values: Record<"identifier", string>,
): Promise<Note | Tombstone | null> => {
  const postId = decodeURIComponent(values.identifier);
  const post = await store.getPost(postId);
  if (!post || post.deleted || post.authorType !== "local") return null;
  const author = await store.getUser(post.authorHandle);
  if (!author) return null;

  return new Note({
    id: noteIdFor(postId),
    attribution: ctx.getActorUri(post.authorHandle),
    content: post.html,
    published: toInstant(post.createdAt),
    to: PUBLIC_COLLECTION,
    url: new URL(`${config.mayaUrl}/post/${postId}`),
  });
};

// ── collection dispatchers ───────────────────────────────────────────────────

const followersDispatcher = async (
  _ctx: Context<unknown>,
  identifier: string,
) => {
  const handle = decodeURIComponent(identifier).toLowerCase();
  const followers = await store.listActiveFediverseFollowers(handle);
  // Recipient objects only need id + inboxId:
  const recipients = [];
  for (const f of followers) {
    const actor = await store.getRemoteActor(f.remoteActorId);
    if (!actor) continue;
    recipients.push({
      id: new URL(actor.actorId),
      inboxId: new URL(actor.inbox),
    });
  }
  return { items: recipients };
};

const followingDispatcher = async (
  _ctx: Context<unknown>,
  identifier: string,
) => {
  const handle = decodeURIComponent(identifier).toLowerCase();
  const items: URL[] = [];
  for (const f of await store.listRemoteFollows(handle)) {
    items.push(new URL(f.remoteActorId));
  }
  return { items };
};

// ── inbox listeners ──────────────────────────────────────────────────────────

function postIdFromApId(apId: string): string | null {
  if (apId.startsWith(config.mayaUrl)) {
    return apId.split("/posts/")[1]?.split(/[?#]/)[0] ?? null;
  }
  return null;
}

async function resolvePostRef(
  ctx: Context<unknown>,
  ref: URL,
): Promise<PostRecord | null> {
  const localId = postIdFromApId(ref.href);
  if (localId) return store.getPost(localId);
  const mirrored = await store.getPostByApId(ref.href);
  if (mirrored) return mirrored;
  // Unknown remote object: resolve its parent post only if it's a note IRI
  // we've seen; otherwise ignore (no fetch cascade).
  void ctx;
  return null;
}

function setupInboxListeners(
  inbox: ReturnType<ReturnType<typeof createFederationBuilder>["setInboxListeners"]>,
): void {
  inbox
    .on(Follow, async (ctx, follow) => {
      const recipient = (ctx as unknown as { recipient: string | null }).recipient;
      if (recipient === null) return;
      const localHandle = decodeURIComponent(recipient).toLowerCase();
      const target = await store.getUser(localHandle);
      if (!target || target.suspended) return;
      const followerId = follow.actorId?.href;
      if (!followerId) return;
      const remote = await resolveRemoteActor(ctx, followerId);
      if (!remote || remote.suspended) return;

      // Queue a follow request for the local user to approve — the actor
      // advertises manuallyApprovesFollowers. An already-approved follower
      // re-sending Follow (key re-sync, server migration…) is re-confirmed
      // immediately instead of being demoted back to pending.
      const existing = await store.getFediverseFollow(localHandle, remote.actorId);
      if (existing?.state === "active") {
        const accept = new Accept({
          id: new URL(`${config.mayaUrl}/activities/${newId()}`),
          actor: ctx.getActorUri(localHandle),
          object: follow,
          to: new URL(followerId),
        });
        try {
          await ctx.sendActivity(
            { identifier: localHandle },
            { id: new URL(followerId), inboxId: new URL(remote.inbox) },
            accept,
          );
        } catch (err) {
          log.warn`Follow re-accept delivery failed: ${err}`;
        }
        log.debug`Follow re-confirmed: ${remote.handle} -> ${localHandle}`;
        return;
      }
      await store.upsertFediverseFollow({
        id: Store.fediverseFollowKey(localHandle, remote.actorId),
        localHandle,
        remoteActorId: remote.actorId,
        state: "pending",
        followActivityId: follow.id?.href ?? null,
        createdAt: existing?.createdAt ?? isoNow(),
      });
      if (existing === null) {
        await store.createNotification({
          toHandle: localHandle,
          type: "remote_follow_request",
          actorHandle: null,
          remoteActorId: remote.actorId,
          postId: null,
          commentId: null,
          message: `${remote.name ?? remote.handle} requested to follow you from the fediverse.`,
        });
      }
      log.debug`Follow request queued: ${remote.handle} -> ${localHandle}`;
    })
    .on(Accept, async (_ctx, accept) => {
      // A remote server confirmed our outbound Follow.
      const actorId = accept.actorId?.href;
      if (!actorId) return;
      const object = await accept.getObject();
      if (!(object instanceof Follow)) return;
      for (const f of await store.remoteFollowsByActor(actorId)) {
        if (f.state === "pending") {
          await store.setRemoteFollowState(f.localHandle, actorId, "active");
          await store.createNotification({
            toHandle: f.localHandle,
            type: "remote_accept",
            actorHandle: null,
            remoteActorId: actorId,
            postId: null,
            commentId: null,
            message: `${actorId} accepted your follow request.`,
          });
          log.debug`Outbound follow confirmed: ${f.localHandle} -> ${actorId}`;
        }
      }
    })
    .on(Create, async (ctx, create) => {
      const object = await create.getObject();
      if (!(object instanceof Note)) return;
      const apId = object.id?.href;
      if (!apId) return;
      if (await store.getPostByApId(apId)) return; // dedupe
      const actorId = create.actorId?.href;
      if (!actorId) return;
      const remote = await store.getRemoteActor(actorId);
      if (!remote || remote.suspended) return;

      const content = object.content !== null ? sanitizePostHtml(String(object.content)) : "";
      const attribution = object.attributionId?.href ?? actorId;
      const author =
        attribution === actorId
          ? remote
          : (await resolveRemoteActor(ctx, attribution)) ?? remote;

      // Thread detection: replies to local posts or already-mirrored posts.
      const replyTargetId = object.replyTargetId?.href ?? null;
      let inReplyToLocalPostId: string | null = null;
      let inReplyToApId: string | null = null;
      if (replyTargetId !== null) {
        if (replyTargetId.startsWith(config.mayaUrl)) {
          const localId = postIdFromApId(replyTargetId);
          if (localId && (await store.getPost(localId))) inReplyToLocalPostId = localId;
        } else {
          const parent = await store.getPostByApId(replyTargetId);
          if (parent) inReplyToApId = replyTargetId;
          else {
            // Mirror the parent reference even if the parent itself is unknown.
            inReplyToApId = replyTargetId;
          }
        }
      }

      const post: PostRecord = {
        id: newId(),
        authorHandle: author.handle,
        authorType: "remote",
        remoteActorId: actorId,
        apId,
        url: object.url instanceof URL ? object.url.href : null,
        html: content,
        textContent: stripHtml(content).slice(0, 500),
        visibility: "public",
        createdAt:
          object.published !== null ? new Date(object.published.toString()).toISOString() : isoNow(),
        attachmentIds: [],
        inReplyToApId,
        inReplyToLocalPostId,
        deleted: false,
      };
      await store.createPost(post);

      if (inReplyToLocalPostId) {
        const localPost = await store.getPost(inReplyToLocalPostId);
        if (localPost && localPost.authorType === "local") {
          await store.createNotification({
            toHandle: localPost.authorHandle,
            type: "comment",
            actorHandle: null,
            remoteActorId: actorId,
            postId: localPost.id,
            commentId: null,
            message: `${remote.name ?? remote.handle} replied to your post from the fediverse.`,
          });
        }
      }
      log.debug`Remote Create stored: ${apId}`;
    })
    .on(Like, async (ctx, like) => {
      const objectId = like.objectId?.href;
      if (!objectId) return;
      const actorId = like.actorId?.href;
      if (!actorId) return;
      const post = await resolvePostRef(ctx, like.objectId ?? new URL(objectId));
      if (!post) return;
      await store.likePost(post.id, `remote:${actorId}`, actorId);
      if (post.authorType === "local") {
        const remote = await store.getRemoteActor(actorId);
        await store.createNotification({
          toHandle: post.authorHandle,
          type: "like",
          actorHandle: null,
          remoteActorId: actorId,
          postId: post.id,
          commentId: null,
          message: `${remote?.name ?? actorId} liked your post.`,
        });
      }
      log.debug`Remote Like: ${actorId} -> ${post.id}`;
    })
    .on(Announce, async (ctx, announce) => {
      const objectId = announce.objectId?.href;
      if (!objectId) return;
      const actorId = announce.actorId?.href;
      if (!actorId) return;
      const post = await resolvePostRef(ctx, announce.objectId ?? new URL(objectId));
      if (!post) return;
      await store.likePost(post.id, `boost:${actorId}`, actorId);
      if (post.authorType === "local") {
        const remote = await store.getRemoteActor(actorId);
        await store.createNotification({
          toHandle: post.authorHandle,
          type: "like",
          actorHandle: null,
          remoteActorId: actorId,
          postId: post.id,
          commentId: null,
          message: `${remote?.name ?? actorId} boosted your post.`,
        });
      }
      log.debug`Remote Announce: ${actorId} -> ${post.id}`;
    })
    .on(Undo, async (ctx, undo) => {
      const object = await undo.getObject();
      const actorId = undo.actorId?.href;
      if (!actorId) return;
      const recipient = (ctx as unknown as { recipient: string | null }).recipient;
      if (object instanceof Follow && recipient !== null) {
        const localHandle = decodeURIComponent(recipient).toLowerCase();
        await store.deleteFediverseFollow(localHandle, actorId);
        log.debug`Remote unfollow: ${actorId} -> ${localHandle}`;
      } else if (object instanceof Like || object instanceof Announce) {
        const objectId = object.objectId?.href;
        if (objectId) {
          const prefix = object instanceof Like ? "remote:" : "boost:";
          const post = await resolvePostRef(ctx, object.objectId ?? new URL(objectId));
          if (post) await store.unlikePost(post.id, `${prefix}${actorId}`);
        }
      }
    })
    .on(Delete, async (_ctx, del) => {
      const objectId = del.objectId?.href;
      if (!objectId) return;
      const post = await store.getPostByApId(objectId);
      if (post) await store.updatePost(post.id, { deleted: true });
      log.debug`Remote Delete: ${objectId}`;
    })
    .on(Update, async (_ctx, update) => {
      const object = await update.getObject();
      if (!(object instanceof Note)) return;
      const apId = object.id?.href;
      if (!apId) return;
      const existing = await store.getPostByApId(apId);
      if (!existing) return;
      const content = object.content !== null ? sanitizePostHtml(String(object.content)) : existing.html;
      await store.updatePost(existing.id, {
        html: content,
        textContent: stripHtml(content).slice(0, 500),
      });
      log.debug`Remote Update applied: ${apId}`;
    });
}

// ── federation assembly ──────────────────────────────────────────────────────

const builder = createFederationBuilder<unknown>();

export async function initFederation() {
  builder
    .setActorDispatcher("/users/{identifier}", actorDispatcher)
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      const handle = decodeURIComponent(identifier).toLowerCase();
      return await getActorKeyPairs(handle);
    });

  builder.setObjectDispatcher(Note, "/posts/{identifier}", noteDispatcher);

  builder
    .setFollowersDispatcher("/users/{identifier}/followers", followersDispatcher)
    .setCounter(async (_ctx, identifier) => {
      const handle = decodeURIComponent(identifier).toLowerCase();
      const followers = await store.listActiveFediverseFollowers(handle);
      return followers.length;
    });

  builder.setFollowingDispatcher("/users/{identifier}/following", followingDispatcher);

  builder
    .setOutboxDispatcher("/users/{identifier}/outbox", async () => ({ items: [] }))
    .setCounter(() => 0);

  builder
    .setLikedDispatcher("/users/{identifier}/liked", async () => ({ items: [] }))
    .setCounter(() => 0);

  const inbox = builder.setInboxListeners("/users/{identifier}/inbox", "/inbox");
  setupInboxListeners(inbox);

  builder.setNodeInfoDispatcher("/nodeinfo", async (_ctx) => ({
    software: {
      name: config.software.name,
      version: config.software.version,
      repository: new URL("https://github.com/mayaspace/mayaspace"),
      homepage: new URL(config.mayaUrl),
    },
    protocols: ["activitypub"],
    openRegistrations: true,
    usage: {
      users: { total: await store.countUsers() },
      localPosts: await store.countPosts(),
      localComments: 0,
    },
    metadata: { nodeName: config.siteName },
  }));

  const { kv, queue } = await makePersistentKv();
  const federation = await builder.build({
    kv,
    queue,
  });
  log.info`Federation initialized for ${config.mayaUrl}`;
  return federation;
}

/** Persistent KV on the same SQLite file via @fedify/sqlite (node:sqlite). */
async function makePersistentKv() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteKvStore, SqliteMessageQueue } = await import("@fedify/sqlite");
  const db = new DatabaseSync(config.dbPath.replace("mayaspace.db", "fedify-cache.db"));
  return { kv: new SqliteKvStore(db), queue: new SqliteMessageQueue(db) };
}

// ── outbound helpers ─────────────────────────────────────────────────────────

export async function sendFollow(
  ctx: Context<unknown>,
  localHandle: string,
  remote: RemoteActorRecord,
): Promise<boolean> {
  const follow = new Follow({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(localHandle),
    object: new URL(remote.actorId),
    to: new URL(remote.actorId),
  });
  try {
    await ctx.sendActivity(
      { identifier: localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      follow,
    );
    await store.upsertRemoteFollow({
      id: `${localHandle}|${remote.actorId}`,
      localHandle,
      remoteActorId: remote.actorId,
      state: "pending",
      createdAt: isoNow(),
    });
    log.debug`Follow sent: ${localHandle} -> ${remote.handle}`;
    return true;
  } catch (err) {
    log.error`Follow delivery failed: ${err}`;
    return false;
  }
}

export async function sendUnfollow(
  ctx: Context<unknown>,
  localHandle: string,
  remote: RemoteActorRecord,
): Promise<boolean> {
  const follow = new Follow({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(localHandle),
    object: new URL(remote.actorId),
    to: new URL(remote.actorId),
  });
  const undo = new Undo({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(localHandle),
    object: follow,
    to: new URL(remote.actorId),
  });
  try {
    await ctx.sendActivity(
      { identifier: localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      undo,
    );
    await store.deleteRemoteFollow(localHandle, remote.actorId);
    return true;
  } catch (err) {
    log.error`Unfollow delivery failed: ${err}`;
    return false;
  }
}

export async function sendCreateNote(ctx: Context<unknown>, post: PostRecord): Promise<void> {
  if (post.authorType !== "local") return;
  const note = new Note({
    id: noteIdFor(post.id),
    attribution: ctx.getActorUri(post.authorHandle),
    content: post.html,
    published: toInstant(post.createdAt),
    to: PUBLIC_COLLECTION,
  });
  const create = new Create({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(post.authorHandle),
    object: note,
    to: PUBLIC_COLLECTION,
  });
  try {
    await ctx.sendActivity({ identifier: post.authorHandle }, "followers", create);
    log.debug`Create(Note) fanned out for ${post.id}`;
  } catch (err) {
    log.warn`Fan-out for ${post.id} failed: ${err}`;
  }
}

export async function sendRemoteLike(
  ctx: Context<unknown>,
  localHandle: string,
  post: PostRecord,
  like: boolean,
): Promise<boolean> {
  if (post.apId === null || post.remoteActorId === null) return false;
  const remote = await store.getRemoteActor(post.remoteActorId);
  if (!remote) return false;
  const inner = new Like({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(localHandle),
    object: new URL(post.apId),
    to: new URL(remote.actorId),
  });
  const activity = like
    ? inner
    : new Undo({
        id: new URL(`${config.mayaUrl}/activities/${newId()}`),
        actor: ctx.getActorUri(localHandle),
        object: inner,
        to: new URL(remote.actorId),
      });
  try {
    await ctx.sendActivity(
      { identifier: localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      activity,
    );
    return true;
  } catch (err) {
    log.warn`Like delivery failed: ${err}`;
    return false;
  }
}

/** Accepts a stored inbound follow request (delivers an Accept activity). */
export async function sendFollowAccept(
  ctx: Context<unknown>,
  follow: FediverseFollowRecord,
  remote: RemoteActorRecord,
): Promise<boolean> {
  const accept = new Accept({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(follow.localHandle),
    object: follow.followActivityId
      ? // Reconstruct a minimal reference to the original Follow activity.
        new Follow({ id: new URL(follow.followActivityId) })
      : undefined,
    to: new URL(remote.actorId),
  });
  try {
    await ctx.sendActivity(
      { identifier: follow.localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      accept,
    );
    return true;
  } catch (err) {
    log.warn`Follow Accept delivery failed: ${err}`;
    return false;
  }
}

/** Rejects a stored inbound follow request (delivers a Reject activity). */
export async function sendFollowReject(
  ctx: Context<unknown>,
  follow: FediverseFollowRecord,
  remote: RemoteActorRecord,
): Promise<boolean> {
  const reject = new Reject({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(follow.localHandle),
    object: follow.followActivityId
      ? new Follow({ id: new URL(follow.followActivityId) })
      : undefined,
    to: new URL(remote.actorId),
  });
  try {
    await ctx.sendActivity(
      { identifier: follow.localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      reject,
    );
    return true;
  } catch (err) {
    log.warn`Follow Reject delivery failed: ${err}`;
    return false;
  }
}

export async function sendDeleteNote(ctx: Context<unknown>, post: PostRecord): Promise<void> {
  if (post.authorType !== "local") return;
  const tombstone = new Tombstone({ id: noteIdFor(post.id) });
  const del = new Delete({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(post.authorHandle),
    object: tombstone,
    to: PUBLIC_COLLECTION,
  });
  try {
    await ctx.sendActivity({ identifier: post.authorHandle }, "followers", del);
  } catch (err) {
    log.warn`Delete delivery failed: ${err}`;
  }
}
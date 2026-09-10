/**
 * The ActivityPub federation core, built on Fedify:
 *  - actor/object dispatchers serving Person + Note documents,
 *  - followers/following/outbox collections,
 *  - inbox listeners: Follow, Create, Like, Announce, Undo, Delete, Update,
 *  - outbound helpers: follow/unfollow, Create/Note fan-out, Like/Undo,
 *    Delete for moderation.
 */
import { createFederationBuilder } from "@fedify/fedify";
import {
  getAuthenticatedDocumentLoader,
  getDocumentLoader,
  kvCache,
  type DocumentLoaderFactory,
  type GetUserAgentOptions,
  type HttpMessageSignaturesSpec,
  type HttpMessageSignaturesSpecDeterminer,
  type KvStore,
} from "@fedify/fedify";
import type { Context, RequestContext } from "@fedify/fedify";
import {
  Accept,
  Announce,
  Create,
  Delete,
  Endpoints,
  Follow,
  Image,
  Like,
  Mention,
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
import type { CommentRecord, FediverseFollowRecord, PostRecord, RemoteActorRecord } from "../types.js";
import { isoNow, newId, parseHttpUrl, stripHtml } from "../util.js";
import { sanitizePostHtml } from "../security/sanitize.js";
import { getActorKeyPairs } from "./keys.js";
import { resolveRemoteActor } from "./remote.js";

const log = appLog("fediverse.federation");

export function actorIdFor(handle: string): URL {
  return new URL(`${config.mayaUrl}/users/${encodeURIComponent(handle)}`);
}

/**
 * Extracts the local handle from a local actor IRI
 * ("{mayaUrl}/users/{handle}") or returns null for anything else.
 */
export function actorHandleFromIri(iri: string): string | null {
  if (!iri.startsWith(`${config.mayaUrl}/users/`)) return null;
  const rest = iri.slice(`${config.mayaUrl}/users/`.length).split(/[?#]/)[0];
  const handle = decodeURIComponent(rest).toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(handle) ? handle : null;
}

export function noteIdFor(postId: string): URL {
  return new URL(`${config.mayaUrl}/posts/${encodeURIComponent(postId)}`);
}

export function commentIdFor(commentId: string): URL {
  return new URL(`${config.mayaUrl}/comments/${encodeURIComponent(commentId)}`);
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

  const actorId = ctx.getActorUri(handle);
  const inbox = ctx.getInboxUri(handle);

  // Public keys MUST be embedded in the served actor document: remote servers
  // verify our outbound HTTP signatures by dereferencing keyId
  // ({actorId}#main-key) and expect to find the key there. Without it every
  // Follow/Accept/Reject we deliver 401s on the remote side — follows stay
  // "pending" forever and Accept/Reject confirmations are silently dropped.
  // assertionMethod (FEP-521a Multikey) is published alongside for
  // spec-compliant verifiers.
  const keyPairs = await ctx.getActorKeyPairs(handle);
  // keys.ts registers the RSA pair first and Ed25519 second, and Fedify names
  // them "#main-key" / "#key-2" in registration order — index-select rather
  // than peeking at privateKey (whose base type is unavailable under this
  // project's lib config).
  const rsaKey = keyPairs[0]?.cryptographicKey ?? null;
  const edMultikey = keyPairs[1]?.multikey ?? null;

  // The shared inbox endpoint lets Mastodon deliver Follow/Undo to one URL
  // instead of per-actor inboxes; without it some servers route deliveries we
  // then can't attribute (ctx.recipient is null on shared-inbox POSTs).
  const endpoints = new Endpoints({ sharedInbox: ctx.getInboxUri() });

  if (handle === SERVICE_ACTOR_HANDLE) {
    return new Service({
      id: actorId,
      name: config.siteName,
      preferredUsername: "MayaSpace",
      inbox,
      outbox: ctx.getOutboxUri(handle),
      endpoints,
      url: new URL(config.mayaUrl),
      manuallyApprovesFollowers: true,
      summary: `Official service actor for ${config.siteName} (${config.mayaUrl}).`,
      ...(rsaKey ? { publicKey: rsaKey } : {}),
      ...(edMultikey ? { assertionMethod: edMultikey } : {}),
    });
  }

  const user = await store.getUser(handle);
  if (!user || user.suspended) return null;

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
    inbox,
    outbox: ctx.getOutboxUri(handle),
    endpoints,
    followers: ctx.getFollowersUri(handle),
    following: ctx.getFollowingUri(handle),
    liked: ctx.getLikedUri(handle),
    url: new URL(`${config.mayaUrl}/u/${handle}`),
    summary: user.bioHtml === "" ? null : user.bioHtml,
    manuallyApprovesFollowers: true,
    published: toInstant(user.createdAt),
    icon,
    ...(rsaKey ? { publicKey: rsaKey } : {}),
    ...(edMultikey ? { assertionMethod: edMultikey } : {}),
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

  const attachments = (await store.listAttachments(postId)).map(
    (attachment) =>
      new Image({
        url: new URL(`${config.mayaUrl}/media/${attachment.filename}`),
        mediaType: attachment.mime,
        name: attachment.originalName,
        width: attachment.width,
        height: attachment.height,
      }),
  );
  return new Note({
    id: noteIdFor(postId),
    attribution: ctx.getActorUri(post.authorHandle),
    content: post.html,
    attachments,
    tags: await localMentionTags(post.textContent),
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
  const url = parseHttpUrl(apId);
  const base = new URL(config.mayaUrl);
  if (!url || url.origin !== base.origin || !url.pathname.startsWith("/posts/")) return null;
  return url.pathname.slice("/posts/".length).split("/")[0] ?? null;
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
      // The Follow's object can also name the local recipient (Mastodon does
      // not deliver to /users/{handle}/inbox when a shared inbox exists, so
      // ctx.recipient is null there — resolve the target from the activity).
      const recipient = (ctx as unknown as { recipient: string | null }).recipient;
      const objectActorIri = follow.objectId?.href ?? null;
      const localHandle =
        recipient !== null
          ? decodeURIComponent(recipient).toLowerCase()
          : objectActorIri !== null && objectActorIri.startsWith(config.mayaUrl)
            ? actorHandleFromIri(objectActorIri)
            : null;
      if (localHandle === null) return;
      const target = await store.getUser(localHandle);
      if (!target || target.suspended) return;
      const followerId = follow.actorId?.href;
      if (!followerId) return;
      const remote = await resolveRemoteActor(ctx, followerId);
      if (!remote || remote.suspended) return;

      // Defense in depth: an actor hosted on this very instance (e.g. a user
      // following their own IRI) must not loop back through our own inbox —
      // local users befriend each other via friend requests instead.
      if (parseHttpUrl(remote.actorId)?.host === new URL(config.mayaUrl).host) {
        log.debug`Ignoring self/own-instance follow: ${remote.handle} -> ${localHandle}`;
        return;
      }

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
      // A remote server confirmed our outbound Follow. The Follow may be
      // embedded OR referenced by IRI only (Mastodon does the latter);
      // getObject() can throw a dereference error on IRI-only Accepts whose
      // targets aren't fetchable, so tolerate failure and fall back to actor
      // matching (we keep one outbound follow per actor).
      const actorId = accept.actorId?.href;
      if (!actorId) return;
      let object = null;
      try {
        object = await accept.getObject({ suppressError: true });
      } catch {
        object = null;
      }
      const followIri = object instanceof Follow ? object.id?.href ?? null : null;
      for (const f of await store.remoteFollowsByActor(actorId)) {
        if (f.state !== "pending") continue;
        // When both sides know the Follow IRI, require a match; otherwise
        // actor-level matching is the only (and sufficient) signal.
        if (followIri !== null && f.followActivityId !== null && f.followActivityId !== followIri) continue;
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
    })
    .on(Create, async (ctx, create) => {
      const object = await create.getObject();
      if (!(object instanceof Note)) return;
      const apId = object.id?.href;
      if (!apId) return;
      if (await store.getPostByApId(apId)) return; // dedupe
      const actorId = create.actorId?.href;
      if (!actorId) return;
      const remote = await resolveRemoteActor(ctx, actorId);
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
      // Shared-inbox deliveries carry no recipient: fall back to the undone
      // Follow's object IRI so remote unfollows still clear local state.
      const recipient = (ctx as unknown as { recipient: string | null }).recipient;
      if (object instanceof Follow) {
        const objectActorIri = object.objectId?.href ?? null;
        const localHandle =
          recipient !== null
            ? decodeURIComponent(recipient).toLowerCase()
            : objectActorIri !== null && objectActorIri.startsWith(config.mayaUrl)
              ? actorHandleFromIri(objectActorIri)
              : null;
        if (localHandle === null) return;
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
      const actorId = del.actorId?.href;
      if (!objectId || !actorId) return;
      const post = await store.getPostByApId(objectId);
      if (!post || post.remoteActorId !== actorId) return;
      await store.updatePost(post.id, { deleted: true });
      log.debug`Remote Delete: ${objectId}`;
    })
    .on(Update, async (_ctx, update) => {
      const object = await update.getObject();
      if (!(object instanceof Note)) return;
      const apId = object.id?.href;
      const actorId = update.actorId?.href;
      if (!apId || !actorId) return;
      const existing = await store.getPostByApId(apId);
      if (!existing || existing.remoteActorId !== actorId) return;
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

// ── signed document loader factories ─────────────────────────────────────────

/**
 * Signed (authenticated) document loaders for the federation, keyed by the
 * instance service actor. Fedify's built-in loaders fetch remote key/actor
 * documents UNSIGNED; servers with authorized fetch enabled (mastodon.social,
 * most of the modern fediverse) answer those with 401. Two breakages follow:
 *  - inbound deliveries fail signature verification because the sender's
 *    keyId cannot be dereferenced ("Failed to verify the request's HTTP
 *    Signatures" → 401 on POST /inbox), and
 *  - outbound lookups (resolveRemoteActor, activity dereferences) fail with
 *    "Failed to fetch document: 401".
 * Wrapping the factories with these signed loaders fixes both: the document
 * loader signs with {mayaUrl}/users/mayaspace#main-key via double-knocking
 * (draft-cavage → rfc9421) and remote servers dereference that keyId from our
 * publicly served actor document. Non-authorized-fetch servers accept signed
 * requests too, so this is a pure upgrade.
 *
 * The document loader stays uncached like Fedify's own authenticated loader
 * (freshness matters for signature-key verification). The CONTEXT loader
 * remains unsigned + KV-cached: JSON-LD @context documents are static
 * vocabulary files on w3.org/w3id.org, which never require authorized fetch —
 * signing them would only add per-fetch round trips, and the cache keeps
 * preloaded contexts off the network entirely.
 *
 * NOTE: documentLoaderFactory/contextLoaderFactory cannot be combined with
 * the allowPrivateAddress or userAgent build options, so dev-mode private
 * address access and the User-Agent are baked into the factories here.
 */

/** Remembers which HTTP-signature spec each remote origin accepted. */
class KvSpecDeterminer implements HttpMessageSignaturesSpecDeterminer {
  constructor(
    private readonly kv: KvStore,
    private readonly defaultSpec: HttpMessageSignaturesSpec = "rfc9421",
  ) {}
  async determineSpec(origin: string): Promise<HttpMessageSignaturesSpec> {
    const stored = await this.kv.get<HttpMessageSignaturesSpec>([
      "_fedify",
      "httpMessageSignaturesSpec",
      origin,
    ]);
    return stored ?? this.defaultSpec;
  }
  async rememberSpec(origin: string, spec: HttpMessageSignaturesSpec): Promise<void> {
    await this.kv.set(["_fedify", "httpMessageSignaturesSpec", origin], spec);
  }
}

async function createSignedLoaderFactories(
  kv: KvStore,
): Promise<{
  documentLoaderFactory: DocumentLoaderFactory;
  contextLoaderFactory: DocumentLoaderFactory;
  authenticatedDocumentLoaderFactory: typeof getAuthenticatedDocumentLoader;
}> {
  const factoryOptions = {
    userAgent: { url: new URL(config.mayaUrl) } satisfies GetUserAgentOptions,
    // Mirror the federation's SSRF policy: on localhost/LAN dev instances the
    // remote side is a private address too, so the guard must not block
    // resolution. In production this stays false.
    allowPrivateAddress: config.allowPrivateFediverseAddresses,
  };
  // Resolve the service actor's RSA key pair up front (the store is already
  // initialized by the time initFederation runs); the factory closes over it.
  const pairs = await getActorKeyPairs(SERVICE_ACTOR_HANDLE);
  const rsa = pairs.find((p) => p.privateKey.algorithm.name === "RSASSA-PKCS1-v1_5");
  if (!rsa) {
    throw new Error("Service actor has no RSASSA-PKCS1-v1_5 key for signed fetching");
  }
  const identity = { keyId: new URL(`${config.mayaUrl}/users/${SERVICE_ACTOR_HANDLE}#main-key`), privateKey: rsa.privateKey };
  const specDeterminer = new KvSpecDeterminer(kv);
  return {
    documentLoaderFactory: () =>
      getAuthenticatedDocumentLoader(identity, { ...factoryOptions, specDeterminer }),
    // Inbound HTTP-signature verification fetches remote keyIds through this
    // factory. Without it Fedify fetches them unsigned, which authorized-fetch
    // servers such as mastodon.social reject with 401.
    authenticatedDocumentLoaderFactory: (actorIdentity, options) =>
      getAuthenticatedDocumentLoader(actorIdentity, { ...factoryOptions, ...options, specDeterminer }),
    contextLoaderFactory: () =>
      kvCache({
        loader: getDocumentLoader(factoryOptions),
        kv,
        kind: "context",
      }),
  };
}

export async function initFederation() {
  builder
    .setActorDispatcher("/users/{identifier}", actorDispatcher)
    // WebFinger acct: resources resolve by username: MayaSpace actor
    // identifiers ARE their lowercase handles, so the mapping is 1:1. Setting
    // the mapper explicitly also keeps fedify from logging an error ("No
    // actor handle mapper is set") on every remote handle lookup.
    .mapAlias(
      (_ctx: RequestContext<unknown>, resource: URL): { username: string } | null => {
        if (!resource.protocol.startsWith("acct:")) return null;
        const handle = resource.pathname.replace(/^@?/, "").split("@")[0].toLowerCase();
        return /^[a-z0-9_]{3,20}$/.test(handle) ? { username: handle } : null;
      },
    )
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

  // Dereferenceable outbound Follow activities: remote servers verify an
  // Accept/Undo by fetching the Follow IRI it references. Reconstruct the
  // activity from the persisted outbound-follow record.
  builder.setObjectDispatcher(Follow, "/activities/{id}", async (ctx, values) => {
    const activityId = decodeURIComponent(values.id);
    const follows = await store.allRemoteFollows();
    const record = follows.find((f) => f.followActivityId?.endsWith(`/activities/${activityId}`));
    if (!record) return null;
    return new Follow({
      id: new URL(`${config.mayaUrl}/activities/${activityId}`),
      actor: ctx.getActorUri(record.localHandle),
      object: new URL(record.remoteActorId),
    });
  });

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
  // Signed document loaders: all Fedify-side remote fetches (inbound signature
  // key dereferences, outbound lookups/activity resolution) are signed with
  // the service actor key so authorized-fetch servers (mastodon.social et al.)
  // don't 401 them. See createSignedLoaderFactories above. If the service
  // actor's keys cannot be produced, fall back to the built-in unsigned
  // loaders and retain the SSRF option for dev instances.
  let signedFactories: Awaited<ReturnType<typeof createSignedLoaderFactories>> | null = null;
  try {
    signedFactories = await createSignedLoaderFactories(kv);
  } catch (err) {
    log.warn`Falling back to unsigned document loaders (service actor keys unavailable): ${err}`;
  }
  // Authorized-fetch servers validate a signed request by dereferencing the
  // keyId in its Signature header — the keyId IRI must therefore resolve over
  // the public internet. A loopback/LAN MAYA_URL makes that impossible, so
  // signed fetches to such servers keep 401ing no matter what the code does.
  // Spell this out at boot instead of letting it surface as mysterious 401s.
  const mayaUrlHost = new URL(config.mayaUrl).hostname;
  if (
    mayaUrlHost === "localhost" ||
    mayaUrlHost.endsWith(".localhost") ||
    mayaUrlHost === "127.0.0.1" ||
    mayaUrlHost === "::1" ||
    mayaUrlHost.startsWith("192.168.") ||
    mayaUrlHost.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(mayaUrlHost)
  ) {
    log.warn`MAYA_URL (${config.mayaUrl}) is not publicly routable. Federation with public servers WILL FAIL: they cannot dereference our actor IRIs or signature keyIds. Use a public https URL (or a tunnel like ngrok/cloudflared) for real cross-server federation. Localhost-to-localhost testing between two MayaSpace instances still works.`;
  }
  const federation = await builder.build({
    kv,
    queue,
    ...(signedFactories ?? {
      // Localhost/LAN dev instances talk to other localhost/LAN instances; the
      // default (production) policy blocks those as SSRF-protected addresses.
      ...(config.allowPrivateFediverseAddresses ? { allowPrivateAddress: true as const } : {}),
    }),
  });
  signedLoadersActive = signedFactories !== null;
  log.info`Federation initialized for ${config.mayaUrl} (${signedFactories ? "signed" : "unsigned"} document loaders)`;
  return federation;
}

/** Whether outbound document fetches are signed with the service actor key. */
let signedLoadersActive = false;

/** Loader mode reported by the federation self-test endpoint. */
export function documentLoaderMode(): string {
  return signedLoadersActive ? "signed (service actor)" : "unsigned (fallback)";
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
  const existing = await store.getRemoteFollow(localHandle, remote.actorId);
  if (existing?.state === "active") return true;
  const followActivityId = existing?.followActivityId ?? `${config.mayaUrl}/activities/${newId()}`;
  const follow = new Follow({
    id: new URL(followActivityId),
    actor: ctx.getActorUri(localHandle),
    object: new URL(remote.actorId),
    to: new URL(remote.actorId),
  });
  // Persist before delivery: a remote inbox may synchronously return Accept,
  // which otherwise reaches our listener before the pending row exists.
  await store.upsertRemoteFollow({
    id: `${localHandle}|${remote.actorId}`,
    localHandle,
    remoteActorId: remote.actorId,
    state: "pending",
    followActivityId,
    createdAt: existing?.createdAt ?? isoNow(),
  });
  try {
    await ctx.sendActivity(
      { identifier: localHandle },
      { id: new URL(remote.actorId), inboxId: new URL(remote.inbox) },
      follow,
    );
    log.debug`Follow sent: ${localHandle} -> ${remote.handle}`;
    return true;
  } catch (err) {
    if (!existing) await store.deleteRemoteFollow(localHandle, remote.actorId);
    log.error`Follow delivery failed: ${err}`;
    return false;
  }
}

export async function sendUnfollow(
  ctx: Context<unknown>,
  localHandle: string,
  remote: RemoteActorRecord,
): Promise<boolean> {
  // Reference the ORIGINAL Follow activity (Mastodon et al. reject Undos whose
  // object doesn't match the Follow they accepted); fall back to a fresh IRI
  // when the record predates followActivityId persistence.
  const stored = await store.getRemoteFollow(localHandle, remote.actorId);
  const follow = new Follow({
    id: new URL(
      stored?.followActivityId ?? `${config.mayaUrl}/activities/${newId()}`,
    ),
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
  } catch (err) {
    log.error`Unfollow delivery failed (local state cleared anyway): ${err}`;
  }
  // Always clear local state: an undeliverable Undo (dead server, missing
  // actor record) must not leave a stuck "pending/active" follow row with no
  // way out of the UI.
  await store.deleteRemoteFollow(localHandle, remote.actorId);
  return true;
}

async function localMentionTags(text: string): Promise<Mention[]> {
  const handles = new Set<string>();
  for (const match of text.matchAll(/@([a-z0-9_]{3,20})\b/gi)) {
    const handle = match[1].toLowerCase();
    if (await store.handleExists(handle)) handles.add(handle);
  }
  return [...handles].map(
    (handle) => new Mention({ href: actorIdFor(handle), name: `@${handle}` }),
  );
}

/**
 * Fans a local comment out as Create(Note) with inReplyTo set to the parent
 * post's note IRI, so Mastodon-style threads pick it up as a reply. Remote
 * Create listener already stores these (it mirrors any Create(Note) whose
 * object has a resolvable apId). Comments on friends-only posts stay local.
 */
export async function sendCreateComment(
  ctx: Context<unknown>,
  post: PostRecord,
  comment: CommentRecord,
): Promise<void> {
  if (comment.authorType !== "local" || post.visibility !== "public") return;
  const note = new Note({
    id: commentIdFor(comment.id),
    attribution: ctx.getActorUri(comment.authorHandle),
    content: comment.html,
    replyTarget: noteIdFor(post.id),
    published: toInstant(comment.createdAt),
    to: PUBLIC_COLLECTION,
  });
  const create = new Create({
    id: new URL(`${config.mayaUrl}/activities/${newId()}`),
    actor: ctx.getActorUri(comment.authorHandle),
    object: note,
    to: PUBLIC_COLLECTION,
  });
  try {
    await ctx.sendActivity({ identifier: comment.authorHandle }, "followers", create);
    log.debug`Create(comment Note) fanned out for ${comment.id}`;
  } catch (err) {
    log.warn`Comment fan-out for ${comment.id} failed: ${err}`;
  }
}

export async function sendCreateNote(ctx: Context<unknown>, post: PostRecord): Promise<void> {
  if (post.authorType !== "local" || post.visibility !== "public") return;
  const attachments = (await store.listAttachments(post.id)).map(
    (attachment) =>
      new Image({
        url: new URL(`${config.mayaUrl}/media/${attachment.filename}`),
        mediaType: attachment.mime,
        name: attachment.originalName,
        width: attachment.width,
        height: attachment.height,
      }),
  );
  const note = new Note({
    id: noteIdFor(post.id),
    attribution: ctx.getActorUri(post.authorHandle),
    content: post.html,
    attachments,
    tags: await localMentionTags(post.textContent),
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
    // Remote implementations commonly require the original Follow's actor and
    // object, not only its IRI, when matching an approval.
    object: follow.followActivityId
      ? new Follow({
          id: new URL(follow.followActivityId),
          actor: new URL(remote.actorId),
          object: ctx.getActorUri(follow.localHandle),
        })
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
      ? new Follow({
          id: new URL(follow.followActivityId),
          actor: new URL(remote.actorId),
          object: ctx.getActorUri(follow.localHandle),
        })
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
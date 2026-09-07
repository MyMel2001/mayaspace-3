/**
 * Data layer. Quick.DB (backed by better-sqlite3) keeps every collection in
 * its own table; each record is a JSON value keyed by a stable id.
 * All access is async from the app's point of view while the underlying
 * driver stays synchronous — no locking concerns, single process.
 */
import { QuickDB } from "quick.db";
import { config } from "./config.js";
import type {
  AttachmentRecord,
  CommentLikeRecord,
  CommentRecord,
  FediverseFollowRecord,
  FriendEdgeRecord,
  FriendRequestRecord,
  LikeRecord,
  ModerationLogRecord,
  NotificationRecord,
  PostRecord,
  RemoteActorRecord,
  RemoteFollowRecord,
  Role,
  UserRecord,
} from "./types.js";
import { isoNow, newId } from "./util.js";


type AnyRecord =
  | UserRecord
  | PostRecord
  | CommentRecord
  | AttachmentRecord
  | FriendRequestRecord
  | FriendEdgeRecord
  | RemoteFollowRecord
  | FediverseFollowRecord
  | RemoteActorRecord
  | NotificationRecord
  | ModerationLogRecord
  | LikeRecord
  | CommentLikeRecord;

const TABLES = [
  "users",
  "posts",
  "comments",
  "attachments",
  "friendRequests",
  "friendEdges",
  "remoteFollows",
  "fediverseFollows",
  "remoteActors",
  "notifications",
  "modLog",
  "likes",
  "commentLikes",
  "kv",
] as const;

export class Store {
  private root!: QuickDB<AnyRecord>;
  users!: QuickDB<UserRecord>;
  posts!: QuickDB<PostRecord>;
  comments!: QuickDB<CommentRecord>;
  attachments!: QuickDB<AttachmentRecord>;
  friendRequests!: QuickDB<FriendRequestRecord>;
  friendEdges!: QuickDB<FriendEdgeRecord>;
  remoteFollows!: QuickDB<RemoteFollowRecord>;
  fediverseFollows!: QuickDB<FediverseFollowRecord>;
  remoteActors!: QuickDB<RemoteActorRecord>;
  notifications!: QuickDB<NotificationRecord>;
  modLog!: QuickDB<ModerationLogRecord>;
  likes!: QuickDB<LikeRecord>;
  commentLikes!: QuickDB<CommentLikeRecord>;
  kv!: QuickDB<string | number | boolean>;

  async init(): Promise<void> {
    this.root = new QuickDB<AnyRecord>({
      filePath: config.dbPath,
      table: "mayaspace_meta",
      // Treat keys literally: Quick.DB with normalKeys=false splits keys on
      // ".", which mangles keys containing remote actor IRIs
      // ("https://mastodon.social/users/…" → nested objects under
      // "https://mastodon") and breaks remote-actor caching + follow state.
      normalKeys: true,
    });
    await this.root.init();
    for (const t of TABLES) {
      if (t === "kv") {
        this.kv = this.root.table("kv") as QuickDB<string | number | boolean>;
        await this.kv.init();
      } else {
        const tbl = this.root.table(t) as QuickDB<never>;
        await tbl.init();
        (this as unknown as Record<string, QuickDB<never>>)[t] = tbl;
      }
    }
    await this.migrateLegacyDottedKeys();
    await this.migrateDoubleEncodedKeys();
    await this.migrateInboundFollows();
    await this.migrateJunkRemoteActors();
  }

  /**
   * Minimal shape check for cached remote actors. Rows that fail it (corrupt
   * writes, probe debris, partial records) poison every consumer that trusts
   * the cache — follow requests, deliveries, profile panels — so they are
   * treated as absent and re-fetched from the network instead.
   */
  static looksLikeRemoteActor(v: unknown): v is RemoteActorRecord {
    if (v === null || typeof v !== "object") return false;
    const r = v as Record<string, unknown>;
    return (
      typeof r.actorId === "string" &&
      r.actorId.startsWith("http") &&
      typeof r.handle === "string" &&
      r.handle !== "" &&
      typeof r.inbox === "string" &&
      r.inbox !== "" &&
      typeof r.createdAt === "string" &&
      typeof r.suspended === "boolean"
    );
  }

  /**
   * One-time sweep: drops remoteActors rows that fail looksLikeRemoteActor.
   * Such rows made getRemoteActor() return garbage (e.g. a "probe" stub),
   * which silently broke follow acceptance and deliveries for that actor.
   */
  private async migrateJunkRemoteActors(): Promise<void> {
    const rows = await this.remoteActors.all<AnyRecord>();
    let dropped = 0;
    for (const row of rows) {
      if (Store.looksLikeRemoteActor(row.value)) continue;
      // Bypass QuickDB.delete (it dot-splits keys even in normalKeys mode).
      await this.root.driver.deleteRowByKey("remoteActors", row.id);
      dropped++;
    }
    if (dropped > 0) console.log(`[store] dropped ${dropped} junk remoteActors row(s)`);
  }

  /**
   * One-time migration from Quick.DB's key mangling eras:
   *  1. normalKeys=false: keys containing "." were split into nested objects
   *     (row "https://mastodon" → {"social/users/x": record}).
   *  2. Brief normalKeys=true interlude: literal rows like
   *     "https://mastodon.social/users/x", plus junk "{}" rows left by
   *     Quick.DB's delete() which ignores normalKeys and always splits on ".".
   * Everything is re-keyed through Store.key() (dot-free base64url) and the
   * junk rows are removed.
   */
  private async migrateLegacyDottedKeys(): Promise<void> {
    // NOTE: must read through kvGet (encoded key) — a raw kv.get() here never
    // sees the encoded marker, so the migration re-ran on every boot and
    // base64url-encoded already-encoded keys one more time each restart.
    const migrated = (await this.kvGet("storeKeyMigrationDone")) === true;
    if (migrated) return;

    const isRecord: Record<string, (v: Record<string, unknown>) => boolean> = {
      remoteActors: (v) => typeof v.actorId === "string" && typeof v.handle === "string",
      remoteFollows: (v) => typeof v.localHandle === "string" && typeof v.remoteActorId === "string",
      likes: (v) => typeof v.postId === "string" && typeof v.liker === "string",
      commentLikes: (v) => typeof v.commentId === "string" && typeof v.liker === "string",
    };

    for (const [t, looksLikeRecord] of Object.entries(isRecord)) {
      const tbl = this.root.table(t) as QuickDB<AnyRecord>;
      const rows = await tbl.all<AnyRecord>();
      const rebuilt: { id: string; value: AnyRecord }[] = [];
      const flatten = (prefix: string, node: unknown): void => {
        if (node !== null && typeof node === "object" && !Array.isArray(node)) {
          const obj = node as Record<string, unknown>;
          if (looksLikeRecord(obj)) {
            rebuilt.push({ id: prefix, value: obj as unknown as AnyRecord });
            return;
          }
          for (const [k, v] of Object.entries(obj)) flatten(`${prefix}.${k}`, v);
        }
      };
      for (const row of rows) {
        const before = rebuilt.length;
        flatten(row.id, row.value);
        if (rebuilt.length > before) {
          // Remove legacy wrapper rows. Bypass QuickDB.delete (it dot-splits
          // even in normalKeys mode) — go straight to the SQLite driver.
          await this.root.driver.deleteRowByKey(t, row.id);
        }
      }
      // Drop junk "{}" rows created by past QuickDB.delete dot-splitting.
      for (const row of rows) {
        if (row.value !== null && typeof row.value === "object" && Object.keys(row.value).length === 0) {
          await this.root.driver.deleteRowByKey(t, row.id);
        }
      }
      for (const { id, value } of rebuilt) {
        const record = { ...(value as unknown as Record<string, unknown>), id: Store.key(id) };
        await tbl.set(Store.key(id), record as AnyRecord);
      }
      if (rebuilt.length > 0) {
        console.log(`[store] migrated ${rebuilt.length} row(s) in "${t}"`);
      }
    }
    await this.kvSet("storeKeyMigrationDone", true);
  }

  /**
   * Repairs rows keyed base64url(base64url(raw)) — the migrateLegacyDottedKeys
   * pass re-encoded keys that were ALREADY base64url (written by the brief
   * Store.key() + normalKeys=true interlude). Because get()/set() encode once,
   * those rows became unreachable: getRemoteActor() misses them, so remote
   * actors get re-fetched and re-inserted after every restart — duplicates
   * piling up in remoteActors/remoteFollows/likes/commentLikes.
   *
   * A double-encoded ID is exactly base64url of a valid base64url string that
   * decodes to the real key. Detection: decode the row id once, and if the
   * result still looks like base64url of the record's canonical key
   * (actorId / composite key present in the record), collapse it.
   */
  private async migrateDoubleEncodedKeys(): Promise<void> {
    if ((await this.kvGet("storeDoubleKeyMigrationDone")) === true) return;

    // canonicalKey(record) → the pre-encoding key this row should sit under.
    const canonical: Record<string, (v: Record<string, unknown>) => string | null> = {
      remoteActors: (v) => (typeof v.actorId === "string" ? v.actorId : null),
      remoteFollows: (v) =>
        typeof v.localHandle === "string" && typeof v.remoteActorId === "string"
          ? Store.remoteFollowKey(v.localHandle, v.remoteActorId)
          : null,
      likes: (v) =>
        typeof v.postId === "string" && typeof v.liker === "string"
          ? Store.likeKey(v.postId, v.liker)
          : null,
      commentLikes: (v) =>
        typeof v.commentId === "string" && typeof v.liker === "string"
          ? Store.commentLikeKey(v.commentId, v.liker)
          : null,
    };

    for (const [t, keyOf] of Object.entries(canonical)) {
      const tbl = this.root.table(t) as QuickDB<AnyRecord>;
      const rows = await tbl.all<AnyRecord>();
      let fixed = 0;
      for (const row of rows) {
        const value = row.value as unknown as Record<string, unknown>;
        const expected = keyOf(value);
        if (expected === null) continue;
        const properId = Store.key(expected);
        if (row.id === properId) continue; // already correct
        if (row.id !== expected && row.id !== Store.key(properId)) {
          // Over-encoded ids (marker bug compounded across restarts): strip
          // base64url layers until we land on the proper key or the raw
          // expected key. unwrapBase64 guarantees each decode round-trips,
          // so this terminates and never mangles a non-encoded id.
          let id = row.id;
          let depth = 0;
          while (id !== properId && id !== expected) {
            const inner = Store.unwrapBase64(id);
            if (inner === null) break;
            id = inner;
            depth++;
          }
          if (!(depth > 0 && (id === properId || id === expected))) continue;
        }
        // When the proper row already exists (the duplicate the running code
        // wrote), keep ITS content and just drop the stray legacy row.
        const alreadyProper = (await tbl.get(properId)) !== null;
        if (!alreadyProper) {
          await tbl.set(properId, { ...(value as unknown as Record<string, unknown>), id: properId } as AnyRecord);
        }
        await this.root.driver.deleteRowByKey(t, row.id);
        fixed++;
      }
      if (fixed > 0) console.log(`[store] re-keyed ${fixed} over-encoded row(s) in "${t}"`);
    }
    await this.kvSet("storeDoubleKeyMigrationDone", true);
  }

  /**
   * Legacy remoteFollows rows doubled as inbound "remote actor follows local
   * user" records: the old inbox listener wrote them with state "active",
   * while outbound follows were always written as "pending" (nothing ever
   * flipped them). Move the active rows into the dedicated fediverseFollows
   * table so the two directions never collide.
   */
  private async migrateInboundFollows(): Promise<void> {
    if ((await this.kvGet("fediverseFollowMigrationDone")) === true) return;
    const rows = await this.remoteFollows.all<RemoteFollowRecord>();
    let moved = 0;
    for (const row of rows) {
      const f = row.value;
      if (!f || f.state !== "active") continue;
      const record: FediverseFollowRecord = {
        id: `in|${f.remoteActorId}|${f.localHandle}`,
        localHandle: f.localHandle,
        remoteActorId: f.remoteActorId,
        state: "active",
        followActivityId: null,
        createdAt: f.createdAt,
      };
      await this.fediverseFollows.set(Store.key(record.id), record);
      await this.remoteFollows.delete(row.id);
      moved++;
    }
    if (moved > 0) console.log(`[store] migrated ${moved} inbound fediverse follow(s)`);
    await this.kvSet("fediverseFollowMigrationDone", true);
  }

  // ── generic helpers ───────────────────────────────────────────────────────

  /**
   * Dot-free storage key. Quick.DB splits keys on "." (get/set with
   * normalKeys=false, and ALWAYS for delete()) — so every key this store
   * writes is encoded to base64url, which cannot contain a dot.
   */
  static key(raw: string): string {
    return Buffer.from(raw, "utf8").toString("base64url");
  }

  /**
   * Strips one base64url layer: returns the decoded string when `id` is a
   * valid base64url encoding, else null. Used to collapse over-encoded keys.
   */
  static unwrapBase64(id: string): string | null {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      const decoded = Buffer.from(id, "base64url").toString("utf8");
      // Round-trip check: re-encoding must reproduce the input exactly.
      return Store.key(decoded) === id ? decoded : null;
    } catch {
      return null;
    }
  }

  /** Loads every row of a table (small-instance scale: fine, single-digit ms). */
  private async all<T extends AnyRecord>(table: QuickDB<T>): Promise<T[]> {
    const rows = await table.all<T>();
    return rows.map((r) => r.value);
  }

  async kvGet(key: string): Promise<string | number | boolean | null> {
    return this.kv.get(Store.key(key));
  }

  async kvSet(key: string, value: string | number | boolean): Promise<void> {
    await this.kv.set(Store.key(key), value);
  }

  // ── users ─────────────────────────────────────────────────────────────────

  async getUser(handle: string): Promise<UserRecord | null> {
    return this.users.get(handle.toLowerCase());
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const users = await this.all(this.users);
    return users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const users = await this.all(this.users);
    const norm = email.trim().toLowerCase();
    return users.find((u) => u.email?.toLowerCase() === norm) ?? null;
  }

  async handleExists(handle: string): Promise<boolean> {
    return this.users.has(handle.toLowerCase());
  }

  async createUser(user: UserRecord): Promise<void> {
    await this.users.set(user.handle, user);
  }

  async updateUser(handle: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const existing = await this.getUser(handle);
    if (!existing) return null;
    const merged: UserRecord = { ...existing, ...patch, handle: existing.handle, id: existing.id };
    await this.users.set(handle, merged);
    return merged;
  }

  async setUserRole(handle: string, role: Role): Promise<void> {
    await this.updateUser(handle, { role });
  }

  /** Substring search over handle/displayName (max 10 results). */
  async searchUsers(query: string, limit = 10): Promise<UserRecord[]> {
    const lower = query.toLowerCase();
    const users = await this.all<UserRecord>(this.users as unknown as QuickDB<UserRecord>);
    const hits: UserRecord[] = [];
    for (const u of users) {
      if (u.suspended) continue;
      if (u.handle.includes(lower) || u.displayName.toLowerCase().includes(lower)) {
        hits.push(u);
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  async countUsers(): Promise<number> {
    const users = await this.all(this.users);
    return users.filter((u) => !u.suspended).length;
  }

  // ── posts ─────────────────────────────────────────────────────────────────

  async createPost(post: PostRecord): Promise<void> {
    await this.posts.set(post.id, post);
  }

  async getPost(id: string): Promise<PostRecord | null> {
    return this.posts.get(id);
  }

  async updatePost(id: string, patch: Partial<PostRecord>): Promise<PostRecord | null> {
    const existing = await this.posts.get(id);
    if (!existing) return null;
    const merged: PostRecord = { ...existing, ...patch, id: existing.id };
    await this.posts.set(id, merged);
    return merged;
  }

  /** Stable cursor pagination over posts, newest first. */
  async listPosts(opts: {
    authorHandle?: string;
    viewerHandle?: string; // for friends-only filtering
    isFriendOf?: (handle: string) => Promise<boolean>;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ items: PostRecord[]; nextCursor: string | null }> {
    const limit = opts.limit ?? 20;
    let rows = await this.all(this.posts);
    rows = rows.filter((p) => !p.deleted);
    if (opts.authorHandle) {
      rows = rows.filter((p) => p.authorHandle === opts.authorHandle!.toLowerCase());
    }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (opts.cursor) {
      const idx = rows.findIndex((p) => p.id === opts.cursor);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    const page: PostRecord[] = [];
    for (const p of rows) {
      if (page.length >= limit) break;
      if (p.visibility === "friends" && opts.viewerHandle !== undefined && opts.isFriendOf) {
        if (p.authorHandle !== opts.viewerHandle && !(await opts.isFriendOf(p.authorHandle))) {
          continue;
        }
      }
      page.push(p);
    }
    const nextCursor = page.length === limit ? page[page.length - 1].id : null;
    return { items: page, nextCursor };
  }

  async countPosts(): Promise<number> {
    const posts = await this.all(this.posts);
    return posts.filter((p) => !p.deleted).length;
  }

  async getPostByApId(apId: string): Promise<PostRecord | null> {
    const posts = await this.all(this.posts);
    return posts.find((p) => p.apId === apId) ?? null;
  }

  // ── comments ──────────────────────────────────────────────────────────────

  async createComment(c: CommentRecord): Promise<void> {
    await this.comments.set(c.id, c);
  }

  async getComment(id: string): Promise<CommentRecord | null> {
    return this.comments.get(id);
  }

  async listComments(postId: string): Promise<CommentRecord[]> {
    const all = await this.all(this.comments);
    return all
      .filter((c) => c.postId === postId && !c.deleted)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async countComments(postId: string): Promise<number> {
    const all = await this.all(this.comments);
    return all.filter((c) => c.postId === postId && !c.deleted).length;
  }

  async getCommentByApId(apId: string): Promise<CommentRecord | null> {
    const all = await this.all(this.comments);
    return all.find((c) => c.apId === apId) ?? null;
  }

  async updateComment(id: string, patch: Partial<CommentRecord>): Promise<CommentRecord | null> {
    const existing = await this.comments.get(id);
    if (!existing) return null;
    const merged: CommentRecord = { ...existing, ...patch, id: existing.id };
    await this.comments.set(id, merged);
    return merged;
  }

  // ── attachments ───────────────────────────────────────────────────────────

  async createAttachment(a: AttachmentRecord): Promise<void> {
    await this.attachments.set(a.id, a);
  }

  async getAttachment(id: string): Promise<AttachmentRecord | null> {
    return this.attachments.get(id);
  }

  async listAttachments(postId: string): Promise<AttachmentRecord[]> {
    const all = await this.all(this.attachments);
    return all.filter((a) => a.postId === postId);
  }

  async listOrphanAttachments(olderThanMs: number): Promise<AttachmentRecord[]> {
    const all = await this.all(this.attachments);
    const cutoff = Date.now() - olderThanMs;
    return all.filter(
      (a) => a.postId === null && Date.parse(a.createdAt) < cutoff,
    );
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.attachments.delete(id);
  }

  async attachmentCountForUser(handle: string, postId: string | null): Promise<number> {
    const all = await this.all(this.attachments);
    return all.filter((a) => a.uploadedBy === handle && a.postId === postId).length;
  }

  async updateAttachmentPost(id: string, postId: string): Promise<AttachmentRecord | null> {
    const existing = await this.attachments.get(id);
    if (!existing) return null;
    const merged: AttachmentRecord = { ...existing, postId };
    await this.attachments.set(id, merged);
    return merged;
  }

  // ── friend requests + edges ───────────────────────────────────────────────

  async createFriendRequest(r: FriendRequestRecord): Promise<void> {
    await this.friendRequests.set(r.id, r);
  }

  async getFriendRequest(id: string): Promise<FriendRequestRecord | null> {
    return this.friendRequests.get(id);
  }

  async listPendingRequestsTo(handle: string): Promise<FriendRequestRecord[]> {
    const all = await this.all(this.friendRequests);
    return all.filter((r) => r.toHandle === handle && r.status === "pending");
  }

  async listPendingRequestsFrom(handle: string): Promise<FriendRequestRecord[]> {
    const all = await this.all(this.friendRequests);
    return all.filter((r) => r.fromHandle === handle && r.status === "pending");
  }

  async updateFriendRequest(
    id: string,
    patch: Partial<FriendRequestRecord>,
  ): Promise<FriendRequestRecord | null> {
    const existing = await this.friendRequests.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, id: existing.id };
    await this.friendRequests.set(id, merged);
    return merged;
  }

  /** Mutual friends of two local users share a lexically-sorted pair key. */
  static edgeKey(a: string, b: string): string {
    return [a, b].sort().join("|");
  }

  async isFriend(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    return this.friendEdges.has(Store.edgeKey(a, b));
  }

  async addFriendEdge(a: string, b: string): Promise<void> {
    const edge: FriendEdgeRecord = {
      id: Store.edgeKey(a, b),
      a: [a, b].sort()[0],
      b: [a, b].sort()[1],
      createdAt: isoNow(),
    };
    await this.friendEdges.set(edge.id, edge);
  }

  async removeFriendEdge(a: string, b: string): Promise<void> {
    await this.friendEdges.delete(Store.edgeKey(a, b));
  }

  async listFriends(handle: string): Promise<string[]> {
    const edges = await this.all(this.friendEdges);
    const out: string[] = [];
    for (const e of edges) {
      if (e.a === handle) out.push(e.b);
      else if (e.b === handle) out.push(e.a);
    }
    return out;
  }

  async friendCount(handle: string): Promise<number> {
    const edges = await this.all(this.friendEdges);
    return edges.filter((e) => e.a === handle || e.b === handle).length;
  }

  // ── remote follows ────────────────────────────────────────────────────────

  static remoteFollowKey(localHandle: string, actorId: string): string {
    return `${localHandle}|${actorId}`;
  }

  async upsertRemoteFollow(f: RemoteFollowRecord): Promise<void> {
    await this.remoteFollows.set(Store.key(Store.remoteFollowKey(f.localHandle, f.remoteActorId)), f);
  }

  async getRemoteFollow(localHandle: string, actorId: string): Promise<RemoteFollowRecord | null> {
    return this.remoteFollows.get(Store.key(Store.remoteFollowKey(localHandle, actorId)));
  }

  async listRemoteFollows(localHandle: string): Promise<RemoteFollowRecord[]> {
    const all = await this.all(this.remoteFollows);
    return all.filter((f) => f.localHandle === localHandle);
  }

  /** Local users that follow a given remote actor (confirmed only). */
  async listRemoteFollowersOf(actorId: string): Promise<RemoteFollowRecord[]> {
    const all = await this.all(this.remoteFollows);
    return all.filter((f) => f.remoteActorId === actorId && f.state === "active");
  }

  /** All outbound follow records a given remote actor is the target of. */
  async remoteFollowsByActor(actorId: string): Promise<RemoteFollowRecord[]> {
    const all = await this.all(this.remoteFollows);
    return all.filter((f) => f.remoteActorId === actorId);
  }

  async setRemoteFollowState(
    localHandle: string,
    actorId: string,
    state: RemoteFollowRecord["state"],
  ): Promise<boolean> {
    const existing = await this.getRemoteFollow(localHandle, actorId);
    if (!existing) return false;
    await this.remoteFollows.set(Store.key(Store.remoteFollowKey(localHandle, actorId)), {
      ...existing,
      state,
    });
    return true;
  }

  async deleteRemoteFollow(localHandle: string, actorId: string): Promise<void> {
    await this.remoteFollows.delete(Store.key(Store.remoteFollowKey(localHandle, actorId)));
  }

  // ── remote actors ─────────────────────────────────────────────────────────

  async upsertRemoteActor(a: RemoteActorRecord): Promise<void> {
    await this.remoteActors.set(Store.key(a.actorId), a);
  }

  async getRemoteActor(actorId: string): Promise<RemoteActorRecord | null> {
    const key = Store.key(actorId);
    const value = await this.remoteActors.get(key);
    if (value === null) return null;
    if (!Store.looksLikeRemoteActor(value)) {
      // Corrupt/partial cache row: evict it so the caller re-resolves the
      // actor from the network rather than acting on garbage.
      try {
        await this.root.driver.deleteRowByKey("remoteActors", key);
      } catch {
        // best-effort eviction
      }
      return null;
    }
    return value;
  }

  async countRemoteActors(): Promise<number> {
    return (await this.all(this.remoteActors)).length;
  }

  async postsByRemoteActor(actorId: string): Promise<PostRecord[]> {
    const posts = await this.all(this.posts);
    return posts
      .filter((p) => p.remoteActorId === actorId && !p.deleted)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Newest-first feed of mirrored remote posts. */
  async remoteFeed(limit: number): Promise<PostRecord[]> {
    const posts = await this.all(this.posts);
    const blocked = new Set(
      (await this.all(this.remoteActors)).filter((a) => a.suspended).map((a) => a.actorId),
    );
    return posts
      .filter((p) => !p.deleted && p.authorType === "remote" && !blocked.has(p.remoteActorId ?? ""))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async listKnownRemoteActors(limit: number): Promise<RemoteActorRecord[]> {
    const all = await this.all(this.remoteActors);
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  // ── fediverse follow requests (remote actor → local user) ─────────────────

  static fediverseFollowKey(localHandle: string, actorId: string): string {
    return `in|${actorId}|${localHandle}`;
  }

  async upsertFediverseFollow(f: FediverseFollowRecord): Promise<void> {
    await this.fediverseFollows.set(
      Store.key(Store.fediverseFollowKey(f.localHandle, f.remoteActorId)),
      f,
    );
  }

  async getFediverseFollow(
    localHandle: string,
    actorId: string,
  ): Promise<FediverseFollowRecord | null> {
    return this.fediverseFollows.get(Store.key(Store.fediverseFollowKey(localHandle, actorId)));
  }

  async listFediverseFollows(handle: string): Promise<FediverseFollowRecord[]> {
    const all = await this.all(this.fediverseFollows);
    return all.filter((f) => f.localHandle === handle);
  }

  /** Confirmed fediverse followers of a local user. */
  async listActiveFediverseFollowers(handle: string): Promise<FediverseFollowRecord[]> {
    return (await this.listFediverseFollows(handle)).filter((f) => f.state === "active");
  }

  /** Fediverse follow requests awaiting the local user's approval. */
  async listPendingFediverseFollowRequests(handle: string): Promise<FediverseFollowRecord[]> {
    return (await this.listFediverseFollows(handle)).filter((f) => f.state === "pending");
  }

  async setFediverseFollowState(
    localHandle: string,
    actorId: string,
    state: FediverseFollowRecord["state"],
  ): Promise<boolean> {
    const existing = await this.getFediverseFollow(localHandle, actorId);
    if (!existing) return false;
    await this.fediverseFollows.set(Store.key(Store.fediverseFollowKey(localHandle, actorId)), {
      ...existing,
      state,
    });
    return true;
  }

  async deleteFediverseFollow(localHandle: string, actorId: string): Promise<void> {
    await this.fediverseFollows.delete(Store.key(Store.fediverseFollowKey(localHandle, actorId)));
  }

  /** Every local user a given remote actor follows (any state). */
  async fediverseFollowsByActor(actorId: string): Promise<FediverseFollowRecord[]> {
    const all = await this.all(this.fediverseFollows);
    return all.filter((f) => f.remoteActorId === actorId);
  }

  // ── likes ─────────────────────────────────────────────────────────────────

  static likeKey(postId: string, liker: string): string {
    return `${postId}:${liker}`;
  }

  async likePost(postId: string, liker: string, remoteActorId: string | null): Promise<void> {
    await this.likes.set(Store.key(Store.likeKey(postId, liker)), {
      id: Store.likeKey(postId, liker),
      postId,
      liker,
      remoteActorId,
      createdAt: isoNow(),
    });
  }

  async unlikePost(postId: string, liker: string): Promise<void> {
    await this.likes.delete(Store.key(Store.likeKey(postId, liker)));
  }

  async hasLiked(postId: string, liker: string): Promise<boolean> {
    return this.likes.has(Store.key(Store.likeKey(postId, liker)));
  }

  async likeCount(postId: string): Promise<number> {
    const all = await this.all(this.likes);
    return all.filter((l) => l.postId === postId).length;
  }

  async likeCountsFor(postIds: string[]): Promise<Map<string, number>> {
    const all = await this.all(this.likes);
    const map = new Map<string, number>(postIds.map((id) => [id, 0]));
    for (const l of all) {
      if (map.has(l.postId)) map.set(l.postId, (map.get(l.postId) ?? 0) + 1);
    }
    return map;
  }

  // ── comment likes ─────────────────────────────────────────────────────────

  static commentLikeKey(commentId: string, liker: string): string {
    return `${commentId}:${liker}`;
  }

  async likeComment(commentId: string, liker: string, remoteActorId: string | null): Promise<void> {
    await this.commentLikes.set(Store.key(Store.commentLikeKey(commentId, liker)), {
      id: Store.commentLikeKey(commentId, liker),
      commentId,
      liker,
      remoteActorId,
      createdAt: isoNow(),
    });
  }

  async unlikeComment(commentId: string, liker: string): Promise<void> {
    await this.commentLikes.delete(Store.key(Store.commentLikeKey(commentId, liker)));
  }

  async hasLikedComment(commentId: string, liker: string): Promise<boolean> {
    return this.commentLikes.has(Store.key(Store.commentLikeKey(commentId, liker)));
  }

  async commentLikeCount(commentId: string): Promise<number> {
    const all = await this.all<CommentLikeRecord>(this.commentLikes as unknown as QuickDB<CommentLikeRecord>);
    return all.filter((l) => l.commentId === commentId).length;
  }

  // ── notifications ─────────────────────────────────────────────────────────

  async createNotification(n: Omit<NotificationRecord, "id" | "createdAt" | "read">): Promise<void> {
    const record: NotificationRecord = { ...n, id: newId(), read: false, createdAt: isoNow() };
    await this.notifications.set(record.id, record);
  }

  async listNotifications(handle: string, limit = 50): Promise<NotificationRecord[]> {
    const all = await this.all(this.notifications);
    return all
      .filter((n) => n.toHandle === handle)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async unreadNotificationCount(handle: string): Promise<number> {
    const all = await this.all(this.notifications);
    return all.filter((n) => n.toHandle === handle && !n.read).length;
  }

  async markNotificationsRead(handle: string): Promise<void> {
    const all = await this.all(this.notifications);
    for (const n of all) {
      if (n.toHandle === handle && !n.read) await this.notifications.set(n.id, { ...n, read: true });
    }
  }

  async pruneNotifications(olderThanMs: number): Promise<number> {
    const all = await this.all(this.notifications);
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const n of all) {
      if (Date.parse(n.createdAt) < cutoff) {
        await this.notifications.delete(n.id);
        removed++;
      }
    }
    return removed;
  }

  // ── moderation log ────────────────────────────────────────────────────────

  async addModLog(entry: Omit<ModerationLogRecord, "id" | "createdAt">): Promise<void> {
    const record: ModerationLogRecord = { ...entry, id: newId(), createdAt: isoNow() };
    await this.modLog.set(record.id, record);
  }

  async listModLog(limit = 100): Promise<ModerationLogRecord[]> {
    const all = await this.all(this.modLog);
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  // ── maintenance ───────────────────────────────────────────────────────────

  async stats(): Promise<{
    users: number;
    posts: number;
    comments: number;
    remoteActors: number;
    friendEdges: number;
  }> {
    return {
      users: await this.countUsers(),
      posts: await this.countPosts(),
      comments: (await this.all(this.comments)).filter((c) => !c.deleted).length,
      remoteActors: await this.countRemoteActors(),
      friendEdges: (await this.all(this.friendEdges)).length,
    };
  }
}

export const store = new Store();
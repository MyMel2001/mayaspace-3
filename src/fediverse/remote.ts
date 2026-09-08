/**
 * Remote actor resolution + fetching remote actor documents through Fedify's
 * signed document loader, with caching in Quick.DB.
 *
 * Many servers (mastodon.social with authorized fetch enabled, for example)
 * reject unsigned GETs of actor documents with 401, so every lookup below is
 * signed with the instance service actor's key. When even the signed fetch
 * fails (dev instances on localhost — the remote cannot dereference our
 * keyId), we fall back to WebFinger-only resolution and cache a minimal
 * "stub" actor record so the profile page still works with an outbound link.
 */
import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { getAuthenticatedDocumentLoader } from "@fedify/fedify";
import { lookupWebFinger } from "@fedify/webfinger";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { RemoteActorRecord } from "../types.js";
import { isoNow, parseHttpUrl, parseRemoteHandle } from "../util.js";
import { sanitizeTextHtml } from "../security/sanitize.js";
import { getActorKeyPairs } from "./keys.js";

const log = appLog("fediverse.remote");

/** The instance-level service actor used to sign outbound document fetches. */
export const SERVICE_ACTOR_HANDLE = "mayaspace";

function coerceString(v: string | vocab.LanguageString | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function firstUrl(
  value: URL | vocab.Link | null | undefined,
): string | null {
  if (value instanceof URL) return value.href;
  if (value instanceof vocab.Link) return value.href?.href ?? null;
  return null;
}

export async function upsertRemoteActorFromPerson(
  actorId: URL,
  person: vocab.Person | vocab.Service | vocab.Application,
): Promise<RemoteActorRecord> {
  const actorIdStr = actorId.href;
  const username = coerceString(person.preferredUsername);
  const handle =
    username !== "" ? `${username.toLowerCase()}@${actorId.host}` : `${actorId.host}@${actorId.host}`;

  const existing = await store.getRemoteActor(actorIdStr);

  // Remote bios are untrusted HTML — reduce to the safe text subset.
  const bioHtml = sanitizeTextHtml(coerceString(person.summary));

  let iconUrl: string | null = person.iconId?.href ?? null;
  if (!iconUrl) {
    const iconIds = person.iconIds ?? [];
    iconUrl = iconIds.length > 0 ? iconIds[0].href : null;
  }

  const htmlUrl = firstUrl(person.url);
  const inbox = person.inboxId?.href ?? actorIdStr;
  const outbox = person.outboxId?.href ?? null;
  const sharedInbox = person.endpoints?.sharedInbox?.href ?? null;

  const record: RemoteActorRecord = {
    actorId: actorIdStr,
    handle,
    name: coerceString(person.name).slice(0, 100) || null,
    bioHtml,
    iconUrl,
    inbox,
    sharedInbox,
    outbox,
    url: htmlUrl,
    isBot: person instanceof vocab.Service,
    createdAt: existing?.createdAt ?? isoNow(),
    suspended: existing?.suspended ?? false,
  };
  await store.upsertRemoteActor(record);
  return record;
}

function isActorLike(doc: vocab.Object): doc is vocab.Person | vocab.Service | vocab.Application {
  return (
    doc instanceof vocab.Person ||
    doc instanceof vocab.Service ||
    doc instanceof vocab.Application ||
    doc instanceof vocab.Group ||
    doc instanceof vocab.Organization
  );
}

/**
 * A signed document loader for lookups, keyed by the instance service actor.
 * Servers with authorized fetch dereference the keyId to verify signatures;
 * when MAYA_URL isn't publicly routable that verification fails and the
 * caller falls back to WebFinger-only resolution.
 */
let signedLoaderCache: { keyId: string; loader: ReturnType<typeof getAuthenticatedDocumentLoader> } | null = null;

async function getSignedLoader(): Promise<
  ((url: string, options?: { signal?: AbortSignal }) => Promise<vocab.RemoteDocument>) | null
> {
  try {
    const keyId = `${config.mayaUrl}/users/${SERVICE_ACTOR_HANDLE}#main-key`;
    if (signedLoaderCache?.keyId === keyId) return signedLoaderCache.loader;
    const pairs = await getActorKeyPairs(SERVICE_ACTOR_HANDLE);
    const rsa = pairs.find((p) => p.privateKey.algorithm.name === "RSASSA-PKCS1-v1_5");
    if (!rsa) return null;
    // Mirror the federation's allowPrivateAddress policy: on localhost dev
    // instances the remote side is a private address too, and the SSRF guard
    // must not block resolving it. Without this the signed loader (passed
    // explicitly into ctx.lookupObject) overrides Fedify's default loader and
    // every remote-actor resolution fails on dev.
    const loader = getAuthenticatedDocumentLoader(
      {
        keyId: new URL(keyId),
        privateKey: rsa.privateKey,
      },
      {
        ...(config.allowPrivateFediverseAddresses ? { allowPrivateAddress: true } : {}),
      },
    ) as unknown as (url: string, options?: { signal?: AbortSignal }) => Promise<vocab.RemoteDocument>;
    signedLoaderCache = { keyId, loader };
    return loader;
  } catch (err) {
    log.debug`Failed to build signed document loader: ${err}`;
    return null;
  }
}

/**
 * WebFinger-only resolution: even when the remote refuses to serve us the
 * actor document, its WebFinger endpoint tells us the actor's canonical IRI
 * and HTML profile URL. We cache a stub record so profiles still render with
 * an outbound link instead of dead-ending with "couldn't be resolved".
 */
async function stubActorFromWebFinger(ref: string): Promise<RemoteActorRecord | null> {
  const parsed = parseRemoteHandle(ref);
  if (!parsed) return null;
  const handle = `${parsed.user}@${parsed.host}`;
  try {
    const jrd = await lookupWebFinger(`acct:${handle}`, {
      ...(config.allowPrivateFediverseAddresses ? { allowPrivateAddress: true } : {}),
    });
    if (jrd === null) return null;
    const selfLink = jrd.links?.find(
      (l) => l.rel === "self" && (l.type === "application/activity+json" || l.type?.startsWith("application/ld+json")),
    );
    const profileLink = jrd.links?.find((l) => l.rel === "http://webfinger.net/rel/profile-page");
    const actorId = selfLink?.href ?? null;
    if (!actorId) return null;
    const existing = await store.getRemoteActor(actorId);
    if (existing) return existing;
    const record: RemoteActorRecord = {
      actorId,
      handle,
      name: null,
      bioHtml: "",
      iconUrl: null,
      inbox: actorId, // replaced once the actor doc is fetchable
      sharedInbox: null,
      outbox: null,
      url: profileLink?.href ?? null,
      isBot: false,
      createdAt: isoNow(),
      suspended: false,
    };
    await store.upsertRemoteActor(record);
    log.debug`Cached WebFinger stub for ${handle} (${actorId})`;
    return record;
  } catch (err) {
    log.debug`WebFinger lookup failed for ${handle}: ${err}`;
    return null;
  }
}

/**
 * Fetches and caches a remote actor by IRI (or resolves "user@host" handles
 * through WebFinger + the document loader). Returns null when unresolvable.
 */
export async function resolveRemoteActor(
  ctx: Context<unknown>,
  ref: string,
): Promise<RemoteActorRecord | null> {
  const loader = await getSignedLoader();

  // Handle form: user@host (with optional leading @)
  if (ref.includes("@") && !ref.startsWith("http")) {
    const handleForm = ref.replace(/^@+/, "");
    try {
      const doc = await ctx.lookupObject(`acct:${handleForm}`, {
        ...(loader ? { documentLoader: loader, contextLoader: loader } : {}),
      });
      if (doc !== null && isActorLike(doc) && doc.id !== null) {
        return await upsertRemoteActorFromPerson(doc.id, doc);
      }
    } catch (err) {
      log.debug`Failed to resolve handle ${ref}: ${err}`;
    }
    return await stubActorFromWebFinger(handleForm);
  }

  // IRI form
  const url = parseHttpUrl(ref);
  if (!url) return null;
  const cached = await store.getRemoteActor(url.href);
  if (cached) {
    // Serve the cache; refresh opportunistically in the background.
    void refreshRemoteActor(ctx, url.href).catch(() => {});
    return cached;
  }
  return refreshRemoteActor(ctx, url.href);
}

export async function refreshRemoteActor(
  ctx: Context<unknown>,
  actorId: string,
): Promise<RemoteActorRecord | null> {
  const loader = await getSignedLoader();
  try {
    const doc = await ctx.lookupObject(new URL(actorId), {
      ...(loader ? { documentLoader: loader, contextLoader: loader } : {}),
    });
    if (doc !== null && isActorLike(doc) && doc.id !== null) {
      return await upsertRemoteActorFromPerson(doc.id, doc);
    }
  } catch (err) {
    log.debug`Failed to refresh actor ${actorId}: ${err}`;
  }
  // Signed/unsigned fetch failed entirely — if this IRI was reached via a
  // handle lookup we can still return the cached/stub record.
  const cached = await store.getRemoteActor(actorId);
  if (cached) return cached;

  // Last resort for profile-URL lookups (e.g. https://host/@user): derive the
  // handle from the URL and try WebFinger, which reveals the canonical IRI.
  const url = parseHttpUrl(actorId);
  if (url) {
    const path = url.pathname.replace(/^\/+/, "");
    const segments = path.split("/");
    const last = segments[segments.length - 1];
    const secondLast = segments.length >= 2 ? segments[segments.length - 2] : "";
    const username =
      url.pathname.startsWith("/@") && last !== ""
        ? last
        : (secondLast === "users" || secondLast === "profile") && last !== ""
          ? last
          : null;
    if (username) {
      const stub = await stubActorFromWebFinger(`${username}@${url.host}`);
      if (stub) return stub;
    }
  }
  return null;
}

/** Best-effort remote actor fetch used before following/delivering. */
export async function ensureRemoteActor(
  ctx: Context<unknown>,
  ref: string,
): Promise<RemoteActorRecord | null> {
  if (!ref.startsWith("http")) return resolveRemoteActor(ctx, ref);
  const cached = await store.getRemoteActor(ref);
  if (cached) {
    // WebFinger stubs carry no usable inbox; re-fetch the actor document so
    // deliveries (e.g. Follow) target a real inbox once the record upgrades.
    if (cached.inbox === cached.actorId) {
      const fresh = await refreshRemoteActor(ctx, ref);
      if (fresh) return fresh;
    }
    return cached;
  }
  return refreshRemoteActor(ctx, ref);
}

export const remoteConfig = { mayaUrl: config.mayaUrl };
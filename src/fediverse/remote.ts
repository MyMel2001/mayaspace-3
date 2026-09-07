/**
 * Remote actor resolution + fetching remote actor documents through Fedify's
 * signed document loader, with caching in Quick.DB.
 */
import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { store } from "../store.js";
import type { RemoteActorRecord } from "../types.js";
import { isoNow, parseHttpUrl, parseRemoteHandle } from "../util.js";
import { sanitizeTextHtml } from "../security/sanitize.js";

const log = appLog("fediverse.remote");

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
 * Fetches and caches a remote actor by IRI (or resolves "user@host" handles
 * through WebFinger + the document loader). Returns null when unresolvable.
 */
export async function resolveRemoteActor(
  ctx: Context<unknown>,
  ref: string,
): Promise<RemoteActorRecord | null> {
  // Handle form: user@host
  if (ref.includes("@") && !ref.startsWith("http")) {
    try {
      const doc = await ctx.lookupObject(`acct:${ref.replace(/^@+/, "")}`);
      if (doc !== null && isActorLike(doc) && doc.id !== null) {
        return await upsertRemoteActorFromPerson(doc.id, doc);
      }
      return null;
    } catch (err) {
      log.debug`Failed to resolve handle ${ref}: ${err}`;
      return null;
    }
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
  try {
    const doc = await ctx.lookupObject(new URL(actorId));
    if (doc !== null && isActorLike(doc) && doc.id !== null) {
      return await upsertRemoteActorFromPerson(doc.id, doc);
    }
    return null;
  } catch (err) {
    log.debug`Failed to refresh actor ${actorId}: ${err}`;
    return null;
  }
}

/** Best-effort remote actor fetch used before following/delivering. */
export async function ensureRemoteActor(
  ctx: Context<unknown>,
  ref: string,
): Promise<RemoteActorRecord | null> {
  if (!ref.startsWith("http")) return resolveRemoteActor(ctx, ref);
  const cached = await store.getRemoteActor(ref);
  if (cached) return cached;
  return refreshRemoteActor(ctx, ref);
}

export const remoteConfig = { mayaUrl: config.mayaUrl };
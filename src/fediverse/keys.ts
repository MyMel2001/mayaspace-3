/**
 * Actor key pairs (RSA-2048 for HTTP Signatures, Ed25519 for FEP-8b32
 * integrity proofs), stored as exported JWKs in the Quick.DB kv table.
 * Private keys never leave this module.
 */
import { generateCryptoKeyPair, exportJwk, importJwk } from "@fedify/fedify";
import { config } from "../config.js";
import { store } from "../store.js";

const KEY_PREFIX = "actorkeys:";

interface Jwk {
  kty: string;
  [key: string]: unknown;
}

interface StoredKeys {
  rsa: { publicJwk: Jwk; privateJwk: Jwk };
  ed25519: { publicJwk: Jwk; privateJwk: Jwk };
}

async function loadStored(handle: string): Promise<StoredKeys | null> {
  const raw = (await store.kvGet(KEY_PREFIX + handle)) as string | null;
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw) as StoredKeys;
  } catch {
    return null;
  }
}

async function generateAndStore(handle: string): Promise<StoredKeys> {
  const rsaPair = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const edPair = await generateCryptoKeyPair("Ed25519");
  const stored: StoredKeys = {
    rsa: {
      publicJwk: await exportJwk(rsaPair.publicKey),
      privateJwk: await exportJwk(rsaPair.privateKey),
    },
    ed25519: {
      publicJwk: await exportJwk(edPair.publicKey),
      privateJwk: await exportJwk(edPair.privateKey),
    },
  };
  await store.kvSet(KEY_PREFIX + handle, JSON.stringify(stored));
  return stored;
}

interface CryptoKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

async function restorePair(
  jwks: { publicJwk: Jwk; privateJwk: Jwk } | undefined,
): Promise<CryptoKeyPair | null> {
  if (!jwks) return null;
  try {
    const publicKey = await importJwk(jwks.publicJwk, "public");
    const privateKey = await importJwk(jwks.privateJwk, "private");
    return { publicKey, privateKey } as CryptoKeyPair;
  } catch {
    return null;
  }
}

/**
 * Returns the actor's key pairs, generating them on first use. Fedify calls
 * this both for outbound signing and to serve public keys in the actor doc.
 */
export async function getActorKeyPairs(handle: string): Promise<CryptoKeyPair[]> {
  let stored = await loadStored(handle);
  if (!stored) stored = await generateAndStore(handle);
  const pairs: CryptoKeyPair[] = [];
  const rsa = await restorePair(stored.rsa);
  const ed = await restorePair(stored.ed25519);
  if (rsa) pairs.push(rsa);
  if (ed) pairs.push(ed);
  if (pairs.length < 2) {
    // corrupt or unreadable keys — regenerate once
    stored = await generateAndStore(handle);
    const fresh = [await restorePair(stored.rsa), await restorePair(stored.ed25519)].filter(
      (p): p is CryptoKeyPair => p !== null,
    );
    return fresh;
  }
  return pairs;
}

export async function hasActorKeys(handle: string): Promise<boolean> {
  return (await loadStored(handle)) !== null;
}

export const keyConfig = { prefix: KEY_PREFIX, mayaUrl: config.mayaUrl };
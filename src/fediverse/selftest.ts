/**
 * Federation self-test: reproduces the exact outbound signed document fetches
 * the signed document loaders perform (double-knock: RFC 9421 first, then
 * draft-cavage-12) against an arbitrary remote actor URL and reports each
 * attempt's outcome — status, error body, sent signature headers, and remote
 * clock skew. Mounted admin-only at /admin/federation-selftest so instances
 * hosted on another machine (no shell access from the dev box) can be
 * diagnosed straight from the browser.
 */
import { signRequest } from "@fedify/fedify/sig";
import type { HttpMessageSignaturesSpec } from "@fedify/fedify/sig";
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { getActorKeyPairs } from "./keys.js";
import { SERVICE_ACTOR_HANDLE } from "./remote.js";
import { documentLoaderMode } from "./federation.js";

const log = appLog("selftest");

export interface ProbeResult {
  label: string;
  url: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  bodySnippet?: string;
  /** `Date` header echoed by the remote (or our own server) — skew evidence. */
  dateHeader: string | null;
  /** Signature-related headers actually attached to the signed request. */
  sentSignatureHeaders?: Record<string, string>;
  location?: string | null;
}

export interface SelfTestReport {
  target: string;
  mayaUrl: string;
  keyId: string;
  documentLoaderMode: string;
  probes: ProbeResult[];
  clockSkewMsByProbe: Record<string, number | null>;
  /** Signed fetch of our own actor doc: proves the keyId URL resolves. */
  keyIdSelfDereference: ProbeResult | null;
  keyIdMatchesSelfDoc: boolean | null;
  verdict: string;
  checkedAt: string;
}

function snippet(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function skewFromDateHeader(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed - Date.now();
}

async function probeOnce(
  label: string,
  url: string,
  makeRequest: () => Promise<{ request: Request }>,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const { request } = await makeRequest();
    const signatureHeaders: Record<string, string> = {};
    for (const name of ["signature", "signature-input", "date"]) {
      const value = request.headers.get(name);
      if (value !== null) signatureHeaders[name] = snippet(value, 160);
    }
    const res = await fetch(request, { redirect: "manual" });
    const body = snippet(await res.text());
    return {
      label,
      url,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      durationMs: Date.now() - started,
      dateHeader: res.headers.get("date"),
      bodySnippet: body === "" ? undefined : body,
      sentSignatureHeaders: Object.keys(signatureHeaders).length > 0 ? signatureHeaders : undefined,
      location: res.headers.get("location"),
    };
  } catch (err) {
    return {
      label,
      url,
      status: null,
      ok: false,
      durationMs: Date.now() - started,
      dateHeader: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs the full diagnostic suite against `target` (an actor/object URL on a
 * remote server). SSRF-conservative: unless this instance is a localhost dev
 * box (allowPrivateFediverseAddresses), only https targets are accepted.
 */
export async function runFederationSelfTest(target: URL): Promise<SelfTestReport> {
  const report: SelfTestReport = {
    target: target.href,
    mayaUrl: config.mayaUrl,
    keyId: `${config.mayaUrl}/users/${SERVICE_ACTOR_HANDLE}#main-key`,
    documentLoaderMode: documentLoaderMode(),
    probes: [],
    clockSkewMsByProbe: {},
    keyIdSelfDereference: null,
    keyIdMatchesSelfDoc: null,
    verdict: "",
    checkedAt: new Date().toISOString(),
  };

  if (!config.allowPrivateFediverseAddresses && target.protocol !== "https:") {
    report.verdict =
      "Rejected: target must be https (this instance is not a localhost dev box).";
    return report;
  }

  let privateKey: CryptoKey;
  try {
    const pairs = await getActorKeyPairs(SERVICE_ACTOR_HANDLE);
    const rsa = pairs.find((p) => p.privateKey.algorithm.name === "RSASSA-PKCS1-v1_5");
    if (!rsa) throw new Error("service actor has no RSA key");
    privateKey = rsa.privateKey;
  } catch (err) {
    report.verdict = `Cannot sign anything: ${err instanceof Error ? err.message : String(err)}`;
    return report;
  }

  const keyId = new URL(report.keyId);
  const signedProbe = async (
    label: string,
    url: string,
    spec: HttpMessageSignaturesSpec,
  ): Promise<ProbeResult> =>
    probeOnce(label, url, async () => {
      const request = new Request(url, {
        headers: { Accept: "application/activity+json" },
      });
      const signed = await signRequest(request, privateKey, keyId, { spec });
      return { request: signed };
    });

  // 1) Baseline: unsigned fetch (expected 401 on authorized-fetch servers).
  const unsigned = await probeOnce("unsigned GET", target.href, async () => ({
    request: new Request(target, { headers: { Accept: "application/activity+json" } }),
  }));
  report.probes.push(unsigned);
  report.clockSkewMsByProbe[unsigned.label] = skewFromDateHeader(unsigned.dateHeader);

  // 2) draft-cavage-12 (what Mastodon actually verifies).
  const cavage = await signedProbe("signed GET (draft-cavage-http-signatures-12)", target.href, "draft-cavage-http-signatures-12");
  report.probes.push(cavage);
  report.clockSkewMsByProbe[cavage.label] = skewFromDateHeader(cavage.dateHeader);

  // 3) RFC 9421.
  const rfc = await signedProbe("signed GET (rfc9421)", target.href, "rfc9421");
  report.probes.push(rfc);
  report.clockSkewMsByProbe[rfc.label] = skewFromDateHeader(rfc.dateHeader);

  // 4) Self-dereference of the keyId base document — proves the keyId URL
  //    actually resolves over the network path this instance uses (Cloudflare
  //    → origin), which is exactly what remote verifiers do.
  const selfDoc = await signedProbe("signed GET (own actor/keyId doc)", `${config.mayaUrl}/users/${SERVICE_ACTOR_HANDLE}`, "draft-cavage-http-signatures-12");
  report.keyIdSelfDereference = selfDoc;
  if (selfDoc.status === 200) {
    try {
      const res = await fetch(`${config.mayaUrl}/users/${SERVICE_ACTOR_HANDLE}`, {
        headers: { Accept: "application/activity+json" },
      });
      const doc = (await res.json()) as { publicKey?: { id?: string } };
      report.keyIdMatchesSelfDoc = doc.publicKey?.id === report.keyId;
    } catch {
      report.keyIdMatchesSelfDoc = false;
    }
  }

  const signedOk = [cavage, rfc].some((p) => p.ok);
  const remoteBody = [cavage.bodySnippet, rfc.bodySnippet]
    .filter((b): b is string => typeof b === "string")
    .join(" ")
    .toLowerCase();
  if (cavage.ok || rfc.ok) {
    report.verdict =
      "Signed fetch SUCCEEDED — signatures and keyId dereference are working for this target. If the UI still shows failures, they are delivery-side (inbox POSTs), not fetch-side.";
  } else if (remoteBody.includes("private network") || remoteBody.includes("privatenetworkaddresserror")) {
    report.verdict =
      `The remote REFUSES to dereference our keyId (${report.keyId}) because it points at a private/loopback address. Remote servers can never validate our signatures with this MAYA_URL — set MAYA_URL to the public https origin and restart.`;
  } else if (selfDoc.status !== 200) {
    report.verdict =
      "Signed fetches to the target fail AND our own keyId document is not reachable from this instance — MAYA_URL is misconfigured or the reverse proxy is broken.";
  } else {
    report.verdict =
      "Signed fetches to the target fail (401) while our keyId document resolves. Remote is rejecting the signature itself: check clock skew above (±12h tolerance for Mastodon), then whether the target actor still exists (401-gated routes also hide deleted accounts).";
  }
  log.info`Federation self-test against ${target.href}: ${report.verdict}`;
  return report;
}
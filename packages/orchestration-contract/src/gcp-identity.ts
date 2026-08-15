/**
 * Cloud Run IAM authenticates every inter-service call on the `Authorization`
 * header, which `workerAuth` (`@townops/shared-ts`) already owns for the
 * shared Worker token — so the Google-signed ID token this module mints
 * travels in `X-Serverless-Authorization` instead, alongside whatever
 * `Authorization` a caller already sends (PRS-140 Phase 5).
 *
 * Both Gateway and Worker depend on this package (Gateway does not depend on
 * `shared-ts`), so the minter and its `fetch` wrapper live here once.
 */

import { z } from "zod/v4";

type CachedToken = { token: string; expiresAtMs: number };

// Only the one claim this module reads out of the token it just minted —
// not a signature-verifying decode, we minted it, we trust it.
const identityTokenPayloadSchema = z.object({ exp: z.number() });

/** Refuse a cached token this close to expiry rather than risk a 401 mid-flight. */
const REFRESH_SKEW_MS = 60_000;

/**
 * How long an "unavailable" outcome (network failure, non-2xx, off) is
 * remembered before the next call retries the metadata server. Without this,
 * every atom call made while GCE metadata is briefly unreachable would retry
 * the network fetch on its own — a needless amplification under load.
 * ponytail: fixed interval, not exponential backoff; raise this if the
 * metadata server is ever observed to be down for longer than it.
 */
const UNAVAILABLE_RETRY_MS = 30_000;

const cache = new Map<string, CachedToken | { unavailableUntilMs: number }>();

function decodeExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("malformed identity token");
  const raw: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  );
  // Validate rather than assert: a token missing `exp` would otherwise yield
  // NaN and cache an entry that never looks expired.
  return identityTokenPayloadSchema.parse(raw).exp * 1000;
}

/**
 * Mints a Google-signed ID token for `audience` from the GCE/Cloud Run
 * metadata server (identical endpoint on both), caching it until 60s before
 * expiry. Returns `undefined` — never throws — when `METADATA_SERVER=off`
 * (local Docker Compose / vitest default, see root `vitest.config.ts`), when
 * the metadata server is unreachable, or when it answers with anything but
 * 200, so every caller can simply skip the header rather than fail the
 * request outright.
 */
export async function getIdentityToken(
  audience: string
): Promise<string | undefined> {
  if (process.env.METADATA_SERVER === "off") return undefined;

  const cached = cache.get(audience);
  const now = Date.now();
  if (cached) {
    if ("token" in cached && cached.expiresAtMs - REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    if ("unavailableUntilMs" in cached && cached.unavailableUntilMs > now) {
      return undefined;
    }
  }

  let response: Response;
  try {
    response = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`,
      { headers: { "Metadata-Flavor": "Google" } }
    );
  } catch {
    cache.set(audience, { unavailableUntilMs: now + UNAVAILABLE_RETRY_MS });
    return undefined;
  }
  if (!response.ok) {
    cache.set(audience, { unavailableUntilMs: now + UNAVAILABLE_RETRY_MS });
    return undefined;
  }

  const token = await response.text();
  let expiresAtMs: number;
  try {
    expiresAtMs = decodeExpiryMs(token);
  } catch {
    // Honour the "never throws" contract above: a malformed token is just
    // another flavour of unavailable, so callers skip the header instead of
    // failing the whole request.
    cache.set(audience, { unavailableUntilMs: now + UNAVAILABLE_RETRY_MS });
    return undefined;
  }
  cache.set(audience, { token, expiresAtMs });
  return token;
}

function originOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).origin;
  return new URL(input).origin;
}

/**
 * Wraps a `fetch` so every request carries an `X-Serverless-Authorization`
 * bearer token minted for the request's own origin — the audience Cloud Run
 * IAM expects — alongside whatever `Authorization` header the caller already
 * set. A no-op (calls `fetchImpl` with `init` untouched) when `mintToken`
 * returns nothing, so a local/off environment sees byte-identical requests.
 */
export function withServerlessAuth(
  fetchImpl: typeof fetch,
  mintToken: (
    audience: string
  ) => Promise<string | undefined> = getIdentityToken
): typeof fetch {
  return async (input, init) => {
    const token = await mintToken(originOf(input));
    if (!token) return fetchImpl(input, init);
    const headers = new Headers(init?.headers);
    headers.set("X-Serverless-Authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

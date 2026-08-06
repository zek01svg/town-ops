import { fetchWithAuth } from "./auth-token";

export type GatewayError = Error & {
  code?: string;
  retryable: boolean;
  status: number;
};

/**
 * Duck-typed, not `instanceof` a custom class — a class check breaks the
 * moment this module is duplicated across the Vite graph, the same hazard
 * that already forces React `dedupe` in every frontend's `vite.config.ts`.
 */
export function isGatewayError(e: unknown): e is GatewayError {
  return e instanceof Error && "retryable" in e;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads `{ code, message, retryable }` off an unknown error body, whatever is present. */
function readError(body: unknown): {
  code?: string;
  message?: string;
  retryable?: boolean;
} {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  const { code, message, retryable } = body.error;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
    retryable: typeof retryable === "boolean" ? retryable : undefined,
  };
}

/**
 * The one place every frontend talks to the Gateway. Delegates the
 * network + 401-refresh half to `fetchWithAuth` unchanged — it still
 * returns a raw `Response` for its other, unmigrated callers — and adds
 * the half `fetchWithAuth` never had: parsing the Gateway's error envelope
 * (`{ error: { code, message, retryable } }`) into a thrown `GatewayError`
 * so callers can branch on `retryable`/`code` instead of treating every
 * failure alike.
 *
 * Returns `unknown` on success — the caller validates with zod.
 * `packages/ui` has no zod dependency and must not gain one, the same
 * structural-boundary rule that keeps `src/libr/timeline.ts` zod-free.
 */
export async function gatewayFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  authUrl: string
): Promise<unknown> {
  const res = await fetchWithAuth(input, init, authUrl);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    const { code, message, retryable } = readError(body);
    throw Object.assign(
      new Error(message ?? `Request failed (${res.status})`),
      { code, retryable: retryable ?? res.status >= 500, status: res.status }
    );
  }
  return res.json();
}

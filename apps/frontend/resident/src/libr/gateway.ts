import type {
  CaseDto,
  MeDto,
  Operation,
  ResidentOpenCaseInput,
} from "@townops/orchestration-contract";

import { env } from "../env";
import { clearAuth, getAuthHeader } from "./auth-token";

type Envelope<T> = { data: T; operation?: Operation };

/**
 * The Resident browser talks to the Gateway and nothing else. Atoms, Temporal,
 * and the auth service are all reached through it, so this module is the only
 * place the frontend knows a backend URL.
 *
 * Errors arrive in the Gateway's one error shape, so the thrown Error carries
 * its `code` for callers that branch on a specific condition.
 */
async function request<T>(
  path: string,
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<Envelope<T>> {
  const { idempotencyKey, headers, ...rest } = init;
  const response = await fetch(`${env.VITE_GATEWAY_URL}${path}`, {
    ...rest,
    headers: {
      ...getAuthHeader(),
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...headers,
    },
  });

  if (response.status === 401) {
    clearAuth();
    throw new Error("Your session has expired. Please sign in again.");
  }

  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw Object.assign(
      new Error(body?.error?.message ?? `Request failed (${response.status})`),
      { code: body?.error?.code as string | undefined }
    );
  }
  return body as Envelope<T>;
}

export async function getMe() {
  return (await request<MeDto>("/api/me")).data;
}

/**
 * Opens a Case for the signed-in Resident. The Resident identity is never sent
 * — the Gateway derives ownership from the bearer token and rejects a
 * client-supplied one. The idempotency key makes a retry after a network
 * failure reattach to the same operation instead of opening a second Case.
 */
export function openCase(input: ResidentOpenCaseInput, idempotencyKey: string) {
  return request<CaseDto>("/api/cases", {
    method: "POST",
    body: JSON.stringify(input),
    idempotencyKey,
  });
}

export async function getCase(caseId: string) {
  return (await request<CaseDto>(`/api/cases/${caseId}`)).data;
}

import {
  CaseDtoSchema,
  MeDtoSchema,
  OperationSchema,
  ResidentAppointmentDtoSchema,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  Operation,
  ReplaceAppointmentInput,
  ResidentAppointmentDto,
  ResidentOpenCaseInput,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

import { env } from "../env";
import { clearAuth, getAuthHeader } from "./auth-token";

type Envelope<T> = { data: T; operation?: Operation };

const errorResponseSchema = z.object({
  error: z
    .object({ message: z.string().optional(), code: z.string().optional() })
    .optional(),
});

const residentCaseDtoSchema = CaseDtoSchema.extend({
  appointment: ResidentAppointmentDtoSchema.nullable(),
});

const replacementDataSchema = z.object({
  appointment: ResidentAppointmentDtoSchema,
  case: CaseDtoSchema,
});

/**
 * How the Gateway projects a Case for the Resident who owns it: the live
 * Appointment sits flat on the Case, with no Assignment envelope — a Resident
 * has nothing to do with allocation bookkeeping.
 */
export type ResidentCaseDto = CaseDto & {
  appointment: ResidentAppointmentDto | null;
};

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
  } = {},
  dataSchema: z.ZodType<T>
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
    const error = errorResponseSchema.safeParse(body);
    throw Object.assign(
      new Error(
        error.data?.error?.message ?? `Request failed (${response.status})`
      ),
      { code: error.data?.error?.code }
    );
  }
  const envelope = z
    .object({ data: dataSchema, operation: OperationSchema.optional() })
    .safeParse(body);
  if (!envelope.success) throw new Error("Invalid Gateway response.");
  return envelope.data;
}

export async function getMe() {
  return (await request("/api/me", {}, MeDtoSchema)).data;
}

/**
 * Opens a Case for the signed-in Resident. The Resident identity is never sent
 * — the Gateway derives ownership from the bearer token and rejects a
 * client-supplied one. The idempotency key makes a retry after a network
 * failure reattach to the same operation instead of opening a second Case.
 */
export function openCase(input: ResidentOpenCaseInput, idempotencyKey: string) {
  return request(
    "/api/cases",
    { method: "POST", body: JSON.stringify(input), idempotencyKey },
    CaseDtoSchema
  );
}

export async function getCase(caseId: string) {
  return (await request(`/api/cases/${caseId}`, {}, residentCaseDtoSchema))
    .data;
}

/**
 * Reschedules the Case's live Appointment. The Gateway requires a reason while
 * the Appointment is still SCHEDULED and accepts one optionally once the
 * Contractor has reported No Access. Reusing the idempotency key across
 * retries reattaches to the same operation instead of booking a second
 * Appointment.
 */
export function replaceAppointment(
  caseId: string,
  appointmentId: string,
  input: ReplaceAppointmentInput,
  idempotencyKey: string
) {
  return request(
    `/api/cases/${caseId}/appointments/${appointmentId}/replacement`,
    { method: "PUT", body: JSON.stringify(input), idempotencyKey },
    replacementDataSchema
  );
}

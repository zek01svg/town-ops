import {
  CaseDtoSchema,
  CancelCaseDataSchema,
  MeDtoSchema,
  OperationSchema,
  ResidentAppointmentDtoSchema,
  TimelineEventDtoSchema,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  CancelCaseInput,
  Operation,
  ReplaceAppointmentInput,
  ResidentAppointmentDto,
  ResidentOpenCaseInput,
} from "@townops/orchestration-contract";
import { gatewayFetch } from "@townops/ui/libr/gateway";
import type { TimelineEvent } from "@townops/ui/libr/timeline";
import { toTimelineEvents } from "@townops/ui/libr/timeline";
import { z } from "zod/v4";

import { env } from "../env";

type Envelope<T> = { data: T; operation?: Operation };

const residentCaseDtoSchema = CaseDtoSchema.extend({
  appointment: ResidentAppointmentDtoSchema.nullable(),
});

const replacementDataSchema = z.object({
  appointment: ResidentAppointmentDtoSchema,
  case: CaseDtoSchema,
});

const casesListDataSchema = z.object({
  items: z.array(CaseDtoSchema),
  page: z.number(),
  pageSize: z.number(),
});

const timelineDataSchema = z.object({
  items: z.array(TimelineEventDtoSchema),
  // Which of the seven atom sources went unreachable — surfaced by
  // `getTimeline` below so the Resident sees a warning, not a shorter
  // timeline that looks complete.
  missingSources: z.array(z.string()),
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
  const body = await gatewayFetch(
    `${env.VITE_GATEWAY_URL}${path}`,
    {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...headers,
      },
    },
    env.VITE_GATEWAY_URL
  );
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
 * Lists the signed-in Resident's own Cases. No `residentId` travels in this
 * request — the Gateway's `GET /api/cases` sets it from the bearer token's
 * actor and re-filters the atom's response server-side. A client-supplied one
 * would be the bug, not the scoping.
 *
 * ponytail: one page of `pageSize=100`. The Gateway returns no `total`, so
 * real pagination needs that added first.
 */
export async function listCases() {
  return (await request("/api/cases?pageSize=100", {}, casesListDataSchema))
    .data.items;
}

/**
 * A Case's merged, ascending activity timeline. The Gateway already redacts
 * this for a Resident (no PERFORMANCE_ENTRY effects, no OFFICER_ATTENTION, no
 * Contractor identity), so nothing is filtered again here. `missingSources`
 * names which of the seven atom sources went unreachable, so a Resident sees
 * a warning instead of a silently shorter timeline.
 */
export async function getTimeline(
  caseId: string
): Promise<{ events: TimelineEvent[]; missingSources: string[] }> {
  const envelope = await request(
    `/api/cases/${caseId}/timeline`,
    {},
    timelineDataSchema
  );
  // `detail: z.unknown()` makes the key optional on the inferred DTO type
  // (undefined is a valid `unknown`) — this re-asserts it present so the
  // structural `TimelineEventInput` (`detail: unknown`, required) that
  // `toTimelineEvents` is pinned to still matches.
  return {
    events: toTimelineEvents(
      envelope.data.items.map((event) => ({ ...event, detail: event.detail }))
    ),
    missingSources: envelope.data.missingSources,
  };
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

export function cancelCase(
  caseId: string,
  input: CancelCaseInput,
  idempotencyKey: string
) {
  return request(
    `/api/cases/${caseId}/cancel`,
    { method: "PUT", body: JSON.stringify(input), idempotencyKey },
    CancelCaseDataSchema
  );
}

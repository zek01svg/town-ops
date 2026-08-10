import { createHash } from "node:crypto";

import {
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
import type { WorkflowClient } from "@temporalio/client";
import {
  AccountRoleSchema,
  AcceptAllocationInputSchema,
  AcceptAllocationResultSchema,
  CancelCaseInputSchema,
  CancelCaseResultSchema,
  AllocationAttemptDtoSchema,
  AppointmentDtoSchema,
  AssignmentDtoSchema,
  CaseDtoSchema,
  CaseStatusSchema,
  CompleteCaseResultSchema,
  CompletionInputSchema,
  DerivedEffectSummarySchema,
  EffectRepairResultSchema,
  HistoricalContractorCaseDtoSchema,
  canonicalManualAllocationPayload,
  canonicalCompletionPayload,
  canonicalCancelCasePayload,
  canonicalAcceptAllocationPayload,
  canonicalOpenCasePayload,
  canonicalReplaceAppointmentPayload,
  canonicalReportNoAccessPayload,
  canonicalRetryEffectPayload,
  canonicalWaiveEffectPayload,
  caseWorkflowId,
  MeDtoSchema,
  ManualAllocationInputSchema,
  ManualAllocationResultSchema,
  OfficerAttentionDtoSchema,
  OfficerCaseDtoSchema,
  canonicalStartWorkPayload,
  OpenCaseInputSchema,
  OpenCaseResultSchema,
  OperationSchema,
  ORCHESTRATION_TASK_QUEUE,
  postalSector,
  ReplaceAppointmentInputSchema,
  ReplaceAppointmentResultSchema,
  RetryEffectInputSchema,
  ReportNoAccessResultSchema,
  ResidentAppointmentDtoSchema,
  ProofItemDtoSchema,
  residentProvisioningWorkflowId,
  ResidentOpenCaseInputSchema,
  StartWorkResultSchema,
  UPDATE_NAMES,
  WaiveEffectInputSchema,
  WORKFLOW_NAMES,
} from "@townops/orchestration-contract";
import type {
  AccountRole,
  AcceptAllocationResult,
  AllocationAttemptDto,
  AppointmentDto,
  ApiError,
  AssignmentDto,
  CaseDto,
  CancelCaseResult,
  CompleteCaseResult,
  DerivedEffectSummary,
  EffectRepairResult,
  ManualAllocationResult,
  OfficerAttentionDto,
  OfficerCaseDto,
  OpenCaseInput,
  OpenCaseResult,
  Operation,
  ProofItemDto,
  ReplaceAppointmentResult,
  ReportNoAccessResult,
  ResidentAppointmentDto,
  StartWorkResult,
  TimelineEventDto,
  TimelineEventSource,
} from "@townops/orchestration-contract";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod/v4";

const idempotencyKeySchema = z.uuid();
const MAX_PROOF_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PROOF_BODY_BYTES = MAX_PROOF_FILE_BYTES + 64 * 1024;

function isSupportedProofImage(file: File, bytes: Uint8Array) {
  switch (file.type.toLowerCase()) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/webp":
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}
const caseAtomResponseSchema = z.object({ cases: z.array(z.unknown()) });
// The internal case atom route (`/internal/cases/:id`, service token) hands
// back one un-redacted record under `case`, not the public route's `cases`
// array — a distinct shape, not a subset, so it gets its own schema.
const internalCaseAtomResponseSchema = z.object({ case: z.unknown() });
const residentAtomResponseSchema = z.object({
  residents: z.array(z.unknown()),
});
const assignmentAtomResponseSchema = z.object({
  assignment: z.unknown().nullable(),
  attempt: z.unknown().nullable(),
});
const appointmentAtomResponseSchema = z.object({
  appointments: z.array(z.unknown()),
});
const proofAtomResponseSchema = z.object({ proof: ProofItemDtoSchema });
const proofAtomListResponseSchema = z.object({
  proof: z.array(ProofItemDtoSchema),
});
const officerAttentionAtomResponseSchema = z.object({
  attentions: z.array(OfficerAttentionDtoSchema),
});
const contractorCaseScopeResponseSchema = z.object({
  items: z.array(
    z.object({
      caseId: z.uuid(),
      assignmentId: z.uuid(),
      participation: z.enum(["CURRENT", "HISTORICAL"]),
    })
  ),
  page: z.number(),
  pageSize: z.number(),
});
const attemptsAtomResponseSchema = z.object({
  attempts: z.array(z.unknown()),
});
const caseHistoryAtomResponseSchema = z.object({
  history: z.array(z.unknown()),
});
const assignmentStatusHistoryAtomResponseSchema = z.object({
  history: z.array(z.unknown()),
});
const derivedEffectsAtomResponseSchema = z.object({
  effects: z.array(DerivedEffectSummarySchema),
});
const authResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
  }),
});
// Atom responses arrive as `unknown`; this narrows them to an indexable shape
// at runtime so the per-field reads below need no type assertion.
const AtomRecordSchema = z.record(z.string(), z.unknown());

// Officer, Contractor, Resident — on their Compose published ports (3001-3003)
// and their Vite dev ports (5173-5175, `strictPort: true` in each
// `vite.config.ts`). Both are needed: every Gateway read carries an
// `Authorization` header, so it is preflighted, and `credentials: true`
// forbids the `"*"` wildcard.
const browserOrigins = new Set([
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
]);

type GatewayWorkflowClient = {
  executeUpdateWithStart(
    updateName: string,
    options: Parameters<WorkflowClient["executeUpdateWithStart"]>[1]
  ): Promise<unknown>;
  start(
    workflowType: string,
    options: Parameters<WorkflowClient["start"]>[1]
  ): Promise<unknown>;
};

type GatewayDependencies = {
  workflowClient: GatewayWorkflowClient;
  caseAtomUrl: string;
  residentAtomUrl: string;
  authAtomUrl: string;
  assignmentAtomUrl?: string;
  appointmentAtomUrl?: string;
  proofAtomUrl?: string;
  alertAtomUrl?: string;
  workerServiceToken?: string;
  authenticate?: MiddlewareHandler;
  fetchImpl?: typeof fetch;
  updateTimeoutMs?: number;
};

type JwtPayload = {
  sub?: unknown;
  role?: unknown;
  name?: unknown;
  email?: unknown;
  contractorId?: unknown;
};
type GatewayEnv = { Variables: { jwtPayload: JwtPayload } };

type Actor = {
  accountId: string;
  role: AccountRole;
  name: string;
  email: string;
  contractorId: string | null;
};

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function error(
  c: Context<GatewayEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503 | 504,
  value: ApiError["error"]
) {
  return c.json({ error: value }, status);
}

function operationFor(
  idempotencyKey: string,
  canonicalPayload: string
): Operation {
  return operationForCase(
    deterministicUuid(idempotencyKey),
    idempotencyKey,
    canonicalPayload
  );
}

function operationForCase(
  caseId: string,
  idempotencyKey: string,
  canonicalPayload: string
): Operation {
  const payloadHash = createHash("sha256")
    .update(canonicalPayload)
    .digest("hex");
  return OperationSchema.parse({
    caseId,
    workflowId: caseWorkflowId(caseId),
    updateId: `${idempotencyKey}.${payloadHash}`,
    idempotencyKey,
  });
}

function isTemporalUnavailable(cause: unknown) {
  if (typeof cause !== "object" || cause === null) return false;
  const code = "code" in cause ? cause.code : undefined;
  const message = "message" in cause ? cause.message : undefined;
  return (
    code === 14 ||
    (typeof message === "string" && /unavailable|econnrefused/i.test(message))
  );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("workflow update timed out")),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toCaseDto(record: unknown): CaseDto {
  const source = AtomRecordSchema.parse(record);
  return CaseDtoSchema.parse({
    ...source,
    category: String(source.category).toUpperCase(),
    priority: String(source.priority).toUpperCase(),
    status: String(source.status).toUpperCase(),
    addressDetails: source.addressDetails ?? null,
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,
  });
}

/**
 * The Officer-only widening of `toCaseDto` (151-D Task 2): same record, same
 * transform, plus the three completion fields `CaseDtoSchema` never carries
 * so they survive `.parse()`'s default strip. Only ever called on a record
 * from the internal, un-redacted case route — never the public one, which
 * omits these fields entirely rather than nulling them.
 */
function toOfficerCaseDto(record: unknown): OfficerCaseDto {
  const source = AtomRecordSchema.parse(record);
  return OfficerCaseDtoSchema.parse({
    ...toCaseDto(source),
    completionOperationId: source.completionOperationId ?? null,
    completionReport: source.completionReport ?? null,
    completionProofItemIds: source.completionProofItemIds ?? null,
  });
}

type CaseAssignment = {
  assignment: AssignmentDto;
  currentAttempt: AllocationAttemptDto | null;
};

/**
 * The tri-state shape `lookupResidentProfile` already uses, generalized:
 * `ABSENT` is a well-formed response with no such record, `UNAVAILABLE` is a
 * fetch throw, a non-ok response, or a response that parsed to an unexpected
 * shape — a malformed payload means the source is not usable, and reporting
 * it as "no data" would silently hide a broken atom (PRS-151 AC8).
 */
type Tristate<T> =
  | { status: "FOUND"; data: T }
  | { status: "ABSENT" }
  | { status: "UNAVAILABLE" };

/** Collapses a `Tristate` to its value, treating ABSENT and UNAVAILABLE the
 * same — the caller that needs to tell them apart (e.g. the Contractor
 * authorization branches below) reads `.status` directly instead. */
function found<T>(lookup: Tristate<T>): T | null {
  return lookup.status === "FOUND" ? lookup.data : null;
}

function toAppointmentDto(record: unknown): AppointmentDto | null {
  const parsed = AtomRecordSchema.safeParse(record);
  if (!parsed.success) return null;
  const source = parsed.data;
  const appointment = AppointmentDtoSchema.safeParse({
    ...source,
    status: String(source.status).toUpperCase(),
  });
  return appointment.success ? appointment.data : null;
}

/**
 * Narrows an Appointment to what a Resident may see (PRS-146). Used on both
 * routes a Resident can reach it through — the Case detail read and the
 * Reschedule success body — so neither hands back what the other strips.
 */
function toResidentAppointmentDto(
  appointment: AppointmentDto | null
): ResidentAppointmentDto | null {
  return appointment ? ResidentAppointmentDtoSchema.parse(appointment) : null;
}

async function lookupAppointment(
  appointmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string,
  attemptId: string | undefined
): Promise<Tristate<AppointmentDto>> {
  // No current Attempt means there is nothing to look up — that is the Case's
  // own state, not the Appointment atom's, so it is ABSENT rather than
  // UNAVAILABLE.
  if (!attemptId) return { status: "ABSENT" };
  let response: Response;
  try {
    response = await fetchImpl(
      `${appointmentAtomUrl}/api/appointments/${caseId}`
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = appointmentAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  // A rescheduled Case holds several Appointments under one Attempt — the
  // Assignment and Attempt stay stable across a replacement (PRS-146 AC7) —
  // and the retired RESCHEDULED/NO_ACCESS rows now survive the DTO parse, so
  // an unordered `.find()` would return an arbitrary one. The atom already
  // reads newest-first; ordering here makes "newest wins" this function's
  // own guarantee rather than a silent dependency on that.
  const match = parsed.data.appointments
    .flatMap((record) => toAppointmentDto(record) ?? [])
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .find((appointment) => appointment.attemptId === attemptId);
  return match ? { status: "FOUND", data: match } : { status: "ABSENT" };
}

/**
 * Looks up a Case's stable Assignment and current pending Attempt from the
 * assignment atom (AC7). `ABSENT` is a well-formed response with no
 * Assignment yet; `UNAVAILABLE` is an unreachable atom or an unexpected
 * response shape. Most callers still fail closed on either (see `found()`) —
 * `GET /api/cases/:caseId`'s Contractor branch is the one place the
 * distinction changes the response (PRS-151 knock-on).
 */
async function lookupCaseAssignment(
  assignmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<Tristate<CaseAssignment>> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${assignmentAtomUrl}/api/assignments/by-case/${caseId}`
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };

  const parsed = assignmentAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  if (!parsed.data.assignment) return { status: "ABSENT" };

  const assignment = AssignmentDtoSchema.safeParse(parsed.data.assignment);
  if (!assignment.success) return { status: "UNAVAILABLE" };

  let currentAttempt: AllocationAttemptDto | null = null;
  if (parsed.data.attempt) {
    const attempt = AllocationAttemptDtoSchema.safeParse(parsed.data.attempt);
    if (attempt.success) currentAttempt = attempt.data;
  }

  return {
    status: "FOUND",
    data: { assignment: assignment.data, currentAttempt },
  };
}

/**
 * Looks up one of a Case's Appointments by ID (PRS-145 start-work
 * authorization pre-check). Authorization-only: it does not filter by
 * status, so a retry-after-ambiguous (the Saga already committed and the
 * Appointment is now IN_PROGRESS) still resolves the row and reaches the
 * Workflow's idempotency-cache replay instead of a stale 404. The Workflow
 * owns the window gate and the Appointment atom owns the status gate
 * (NOT_SCHEDULED) — this only confirms the row belongs to this Case and
 * Contractor. An unreachable atom, an unexpected response shape, or no
 * matching row resolves to null rather than failing closed with a 5xx.
 */
async function lookupCurrentAppointment(
  appointmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string,
  appointmentId: string
): Promise<AppointmentDto | null> {
  try {
    const response = await fetchImpl(
      `${appointmentAtomUrl}/api/appointments/${caseId}`
    );
    if (!response.ok) return null;
    const parsed = appointmentAtomResponseSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!parsed.success) return null;
    return (
      parsed.data.appointments
        .map(toAppointmentDto)
        .find((appointment) => appointment?.id === appointmentId) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Resolves the authenticated Actor from the JWT payload the `authenticate`
 * middleware attaches to the request context. Legacy rows still carry
 * lowercase roles, so the role claim is uppercased defensively before being
 * validated against the fixed Account Role enum. Returns undefined when the
 * token cannot back a usable Actor — a missing/invalid subject or an
 * unrecognized role.
 */
function resolveActor(jwtPayload: JwtPayload | undefined): Actor | undefined {
  if (!jwtPayload) return undefined;

  const accountId = z.uuid().safeParse(jwtPayload.sub);
  const role = AccountRoleSchema.safeParse(
    typeof jwtPayload.role === "string"
      ? jwtPayload.role.toUpperCase()
      : jwtPayload.role
  );
  if (!accountId.success || !role.success) return undefined;

  return {
    accountId: accountId.data,
    role: role.data,
    name: typeof jwtPayload.name === "string" ? jwtPayload.name : "",
    email: typeof jwtPayload.email === "string" ? jwtPayload.email : "",
    contractorId:
      typeof jwtPayload.contractorId === "string"
        ? jwtPayload.contractorId
        : null,
  };
}

type ResidentProfileLookup =
  | { status: "FOUND" }
  | { status: "ABSENT" }
  | { status: "UNAVAILABLE" };

/**
 * Looks up whether a Resident profile already exists for an Account. Shared
 * by `/api/me` and Case opening so both agree on found / absent / unreachable
 * without duplicating the Resident atom call.
 */
async function lookupResidentProfile(
  residentAtomUrl: string,
  fetchImpl: typeof fetch,
  accountId: string
): Promise<ResidentProfileLookup> {
  let response: Response;
  try {
    response = await fetchImpl(`${residentAtomUrl}/api/residents/${accountId}`);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };

  const parsed = residentAtomResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.residents.length === 0) {
    return { status: "ABSENT" };
  }
  return { status: "FOUND" };
}

/**
 * Fires a reconciliation attempt at the Resident Provisioning workflow.
 * Always a best-effort nudge: the caller never awaits it, and a rejection
 * must never escape, since provisioning is not the caller's critical path.
 */
function ensureResidentProvisioning(
  workflowClient: GatewayWorkflowClient,
  actor: { accountId: string; name: string; email: string }
) {
  workflowClient
    .start(WORKFLOW_NAMES.residentProvisioning, {
      workflowId: residentProvisioningWorkflowId(actor.accountId),
      taskQueue: ORCHESTRATION_TASK_QUEUE,
      args: [
        {
          accountId: actor.accountId,
          fullName: actor.name,
          email: actor.email,
        },
      ],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    })
    .catch(() => undefined);
}

// ─── Case timeline (PRS-151) ────────────────────────────────────────────────
// Seven atoms, one merged and sorted read. Every per-source fetcher below
// resolves to `TimelineSourceLookup` — FOUND (possibly empty) or
// UNAVAILABLE — never throws, so `Promise.all` in the route below always
// settles and an unreachable atom degrades to `missingSources` (AC8) rather
// than failing the whole read.

/**
 * A `TimelineEventDto` carrying the contractor it belongs to, when the
 * source names one. Used only to filter a historical Contractor's view
 * (AC6) and stripped before the response leaves the Gateway — the contract
 * DTO has no such field, since only the Gateway needs it.
 */
type TimelineEvent = TimelineEventDto & { contractorId: string | null };

type TimelineSourceLookup =
  | { status: "FOUND"; events: TimelineEvent[] }
  | { status: "UNAVAILABLE" };

function allocationAttemptEvent(attempt: AllocationAttemptDto): TimelineEvent {
  return {
    id: attempt.id,
    at: attempt.createdAt,
    source: "ALLOCATION_ATTEMPT",
    type: attempt.status,
    actorId: attempt.actorId,
    actorRole: attempt.actorRole,
    reason: attempt.reason,
    operationId: attempt.operationId,
    detail: attempt,
    contractorId: attempt.contractorId,
  };
}

/**
 * `lookupAttemptHistory`'s result. Deliberately not `Tristate<T>` — an empty
 * Attempt list ("no Assignment yet") is a normal FOUND, not an ABSENT this
 * caller needs to branch on, so there is no third state.
 */
type AttemptHistoryLookup =
  | { status: "FOUND"; data: AllocationAttemptDto[] }
  | { status: "UNAVAILABLE" };

/**
 * Every Attempt ever offered for a Case (151-A), oldest first, `[]` when the
 * Case has no Assignment yet. A PRIMARY source for a Contractor's timeline
 * authorization (the only way to know whether they ever held the Case) and
 * a secondary timeline source for everyone else.
 */
async function lookupAttemptHistory(
  assignmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<AttemptHistoryLookup> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${assignmentAtomUrl}/api/assignments/by-case/${caseId}/attempts`
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = attemptsAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  const attempts = parsed.data.attempts.flatMap((record) => {
    const attempt = AllocationAttemptDtoSchema.safeParse(record);
    return attempt.success ? [attempt.data] : [];
  });
  return { status: "FOUND", data: attempts };
}

/**
 * The Attempt with the latest `createdAt`, ties broken by the smallest id —
 * the same rule the assignment atom's own Contractor Case scope route uses
 * to decide CURRENT vs HISTORICAL (`listCasesForContractor`), kept
 * consistent here so a Contractor's timeline never disagrees with their
 * Case list about which Attempt is current.
 */
function newestAttempt(
  attempts: AllocationAttemptDto[]
): AllocationAttemptDto | undefined {
  return attempts.reduce<AllocationAttemptDto | undefined>(
    (newest, attempt) => {
      if (!newest) return attempt;
      const delta =
        Date.parse(attempt.createdAt) - Date.parse(newest.createdAt);
      if (delta > 0) return attempt;
      if (delta === 0 && attempt.id < newest.id) return attempt;
      return newest;
    },
    undefined
  );
}

/**
 * `case_history` carries the full `(actorId, actorRole, reason,
 * operationId)` tuple, but has no contract DTO of its own — this reads the
 * atom's raw JSON row the same defensive way `toCaseDto`/`toAppointmentDto`
 * do, skipping (not failing) a row missing its required fields.
 */
function caseHistoryEvent(record: unknown): TimelineEvent | undefined {
  const parsed = AtomRecordSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  const id = typeof row.id === "string" ? row.id : undefined;
  const at = typeof row.createdAt === "string" ? row.createdAt : undefined;
  const type = typeof row.eventType === "string" ? row.eventType : undefined;
  if (!id || !at || !type) return undefined;
  return {
    id,
    at,
    source: "CASE_HISTORY",
    type,
    actorId: typeof row.actorId === "string" ? row.actorId : null,
    actorRole: typeof row.actorRole === "string" ? row.actorRole : null,
    reason: typeof row.reason === "string" ? row.reason : null,
    operationId: typeof row.operationId === "string" ? row.operationId : null,
    detail: row,
    contractorId: null,
  };
}

async function fetchCaseHistorySource(
  caseAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<TimelineSourceLookup> {
  let response: Response;
  try {
    response = await fetchImpl(`${caseAtomUrl}/api/cases/${caseId}/history`);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = caseHistoryAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: parsed.data.history.flatMap(
      (record) => caseHistoryEvent(record) ?? []
    ),
  };
}

/**
 * `assignment_status_history.changed_by` is text, not a uuid — there is no
 * separate actor id/role tracked, so `changedBy` maps straight onto
 * `actorId` (itself a plain string in `TimelineEventDto`, precisely so this
 * needs no uuid parse) and `actorRole` stays null. The table also has no
 * `operationId` column.
 */
function assignmentStatusEvent(record: unknown): TimelineEvent | undefined {
  const parsed = AtomRecordSchema.safeParse(record);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  const id = typeof row.id === "string" ? row.id : undefined;
  const at = typeof row.changedAt === "string" ? row.changedAt : undefined;
  const type = typeof row.toStatus === "string" ? row.toStatus : undefined;
  if (!id || !at || !type) return undefined;
  return {
    id,
    at,
    source: "ASSIGNMENT_STATUS",
    type,
    actorId: typeof row.changedBy === "string" ? row.changedBy : null,
    actorRole: null,
    reason: typeof row.reason === "string" ? row.reason : null,
    operationId: null,
    detail: row,
    contractorId: null,
  };
}

async function fetchAssignmentStatusSource(
  assignmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<TimelineSourceLookup> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${assignmentAtomUrl}/api/assignments/${caseId}/history`
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = assignmentStatusHistoryAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: parsed.data.history.flatMap(
      (record) => assignmentStatusEvent(record) ?? []
    ),
  };
}

function appointmentEvent(appointment: AppointmentDto): TimelineEvent {
  return {
    id: appointment.id,
    at: appointment.createdAt,
    source: "APPOINTMENT",
    type: appointment.status,
    actorId: null,
    actorRole: null,
    reason: appointment.reason,
    operationId: appointment.operationId,
    detail: appointment,
    contractorId: appointment.contractorId,
  };
}

async function fetchAppointmentSource(
  appointmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<TimelineSourceLookup> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${appointmentAtomUrl}/api/appointments/${caseId}`
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = appointmentAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: parsed.data.appointments.flatMap((record) => {
      const appointment = toAppointmentDto(record);
      return appointment ? [appointmentEvent(appointment)] : [];
    }),
  };
}

function proofItemEvent(proofItem: ProofItemDto): TimelineEvent | undefined {
  // `createdAt` is nullable on the DTO for an item that is not yet ready —
  // the internal route only ever returns ready items, but a timeline row
  // with no timestamp cannot be placed, so it is skipped defensively.
  if (!proofItem.createdAt) return undefined;
  return {
    id: proofItem.id,
    at: proofItem.createdAt,
    source: "PROOF_ITEM",
    type: proofItem.type,
    actorId: null,
    actorRole: null,
    reason: null,
    operationId: null,
    detail: proofItem,
    contractorId: proofItem.contractorId,
  };
}

/**
 * `contractorId` is omitted here for every role, not just OFFICER — a
 * CURRENT Contractor must still see a replaced predecessor's Proof Items
 * (Task 4 only drops OFFICER_ATTENTION for them), so the fetch stays
 * unfiltered and the Contractor-HISTORICAL narrowing happens once, in the
 * shared role filter below, the same way it does for every other source.
 */
async function fetchProofItemSource(
  proofAtomUrl: string,
  fetchImpl: typeof fetch,
  workerServiceToken: string,
  caseId: string
): Promise<TimelineSourceLookup> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${proofAtomUrl}/internal/proof-items/${caseId}`,
      {
        headers: { Authorization: `Bearer ${workerServiceToken}` },
      }
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = proofAtomListResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: parsed.data.proof.flatMap((item) => proofItemEvent(item) ?? []),
  };
}

/**
 * `waiverActorId`/`waiverReason` are the only actor/reason data a Derived
 * Effect carries — the immutable `payload`'s own `reason` (for a
 * PERFORMANCE_ENTRY) is deliberately never exposed (PRS-151 locked
 * decision), and there is no `operationId` column at all.
 */
function derivedEffectEvent(effect: DerivedEffectSummary): TimelineEvent {
  return {
    id: effect.id,
    at: effect.createdAt,
    source: "DERIVED_EFFECT",
    type: effect.type,
    actorId: effect.waiverActorId,
    actorRole: null,
    reason: effect.waiverReason,
    operationId: null,
    detail: effect,
    contractorId: effect.contractorId,
  };
}

async function fetchDerivedEffectSource(
  alertAtomUrl: string,
  fetchImpl: typeof fetch,
  workerServiceToken: string,
  caseId: string
): Promise<TimelineSourceLookup> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${alertAtomUrl}/internal/effects/case/${caseId}`,
      {
        headers: { Authorization: `Bearer ${workerServiceToken}` },
      }
    );
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (!response.ok) return { status: "UNAVAILABLE" };
  const parsed = derivedEffectsAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: parsed.data.effects.map(derivedEffectEvent),
  };
}

function officerAttentionEvent(attention: OfficerAttentionDto): TimelineEvent {
  return {
    id: attention.id,
    at: attention.createdAt,
    source: "OFFICER_ATTENTION",
    type: attention.kind,
    actorId: null,
    actorRole: null,
    reason: null,
    operationId: attention.operationId,
    detail: attention,
    contractorId: null,
  };
}

/**
 * Officer Attention has no "all" state filter, only open/resolved — this
 * merges both into the one OFFICER_ATTENTION timeline source. Either call
 * failing marks the whole source UNAVAILABLE rather than silently showing
 * half of it.
 * ponytail: `pageSize: 100` (the atom's own max) per state is not a true
 * "all" — raise this if a Case ever plausibly carries more Attentions than
 * that.
 */
async function fetchOfficerAttentionSource(
  caseAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<TimelineSourceLookup> {
  async function fetchState(state: "open" | "resolved") {
    let response: Response;
    try {
      response = await fetchImpl(
        `${caseAtomUrl}/api/cases/officer-attention?${new URLSearchParams({
          state,
          caseId,
          pageSize: "100",
        })}`
      );
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    const parsed = officerAttentionAtomResponseSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    return parsed.success ? parsed.data.attentions : undefined;
  }
  const [open, resolved] = await Promise.all([
    fetchState("open"),
    fetchState("resolved"),
  ]);
  if (!open || !resolved) return { status: "UNAVAILABLE" };
  return {
    status: "FOUND",
    events: [...open, ...resolved].map(officerAttentionEvent),
  };
}

/**
 * Task 4's role filter, applied once every source is normalized into the
 * same shape so one predicate set covers all seven. `participation` is null
 * for RESIDENT/OFFICER, where it plays no part.
 */
function includeTimelineEventForRole(
  event: TimelineEvent,
  actor: Actor,
  participation: "CURRENT" | "HISTORICAL" | null
): boolean {
  if (actor.role === "RESIDENT") {
    // Deny-by-default, same reasoning and the same hazard as the Contractor
    // branch below: this is an allow-list over the seven sources, and the
    // exhaustive switch turns an eighth source added later into a compile
    // error instead of a silent `return true`.
    //
    // ALLOCATION_ATTEMPT and ASSIGNMENT_STATUS are Contractor allocation
    // bookkeeping — exactly what `ResidentAppointmentDtoSchema`
    // (packages/orchestration-contract/src/index.ts:402-408) already drops
    // `contractorId`/`attemptId` for on the Case detail route, "because
    // allocation bookkeeping would expose Contractor churn across
    // Acceptance SLA Breaches." Dropping both sources here keeps the
    // timeline consistent with that decision instead of re-exposing the
    // same churn through a second surface. The surviving sources still get
    // narrowed by `redactForResident()` below — this only decides whether a
    // source is reachable at all.
    switch (event.source) {
      case "CASE_HISTORY":
      case "APPOINTMENT":
      case "PROOF_ITEM":
        return true;
      case "DERIVED_EFFECT":
        return event.type !== "PERFORMANCE_ENTRY";
      case "ALLOCATION_ATTEMPT":
      case "ASSIGNMENT_STATUS":
      case "OFFICER_ATTENTION":
        return false;
      default: {
        const unhandledSource: never = event.source;
        throw new Error(
          `Unhandled timeline source: ${String(unhandledSource)}`
        );
      }
    }
  }
  if (actor.role === "CONTRACTOR") {
    if (event.source === "OFFICER_ATTENTION") return false;
    if (participation !== "HISTORICAL") return true;

    // Deny-by-default, on purpose: AC5 names exactly four things a
    // historical Contractor keeps (its own Attempts, Appointments, Proof
    // Items, and Performance Entries), and the two sources excluded below
    // (CASE_HISTORY, ASSIGNMENT_STATUS) carry no reliable per-row contractor
    // attribution to scope by even if they were on the list —
    // `assignmentStatusEvent()` maps `changed_by` onto `actorId`, and the
    // mainline acceptance path writes the *accepting* Contractor's id there
    // regardless of who is asking; `caseHistoryEvent()`'s `operationId`
    // embeds the winning Contractor's id verbatim for auto-allocation. An
    // exclusion list over those two would leak the next source added to
    // `TimelineEventSourceSchema` by default — unfiltered, silently, in the
    // exact function that already shipped one AC5 leak. This switch is an
    // allow-list instead, and the `default` arm turns an unhandled source
    // into a compile error (`event.source` fails to narrow to `never`)
    // rather than a silent `return true`: adding an eighth source forces
    // whoever adds it to decide here, on purpose, which bucket it belongs in.
    switch (event.source) {
      case "ALLOCATION_ATTEMPT":
      case "APPOINTMENT":
      case "PROOF_ITEM":
      case "DERIVED_EFFECT":
        return event.contractorId === actor.contractorId;
      case "CASE_HISTORY":
      case "ASSIGNMENT_STATUS":
        return false;
      default: {
        const unhandledSource: never = event.source;
        throw new Error(
          `Unhandled timeline source: ${String(unhandledSource)}`
        );
      }
    }
  }
  // OFFICER: AccountRoleSchema is an exhaustive 3-value enum and
  // resolveActor() already 401s anything else, so this is the only
  // remaining branch — an Officer sees every source, unfiltered.
  return true;
}

/** A plain, non-array object — `Record<string, unknown>` narrowed at
 * runtime rather than asserted, for `redactForResident`'s `detail` guards. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows what a Resident sees *within* a source `includeTimelineEventForRole`
 * has already let through — that function decides reachability, this decides
 * content. Mirrors `ResidentAppointmentDtoSchema`'s existing "no Contractor
 * churn" rule (contract:402-408) everywhere a Contractor id can otherwise
 * reach a Resident:
 *  - CASE_HISTORY: `actorId` is the acting party — a Contractor on
 *    contractor-driven transitions — and `operationId` embeds a Contractor's
 *    id verbatim for auto-allocation (`${caseId}/allocate/${contractorId}/${epoch}`).
 *    Both are nulled, in `detail` too, not just the flattened fields.
 *    `actorRole` stays: "a Contractor started work" is the useful,
 *    non-identifying fact this source exists to carry.
 *  - APPOINTMENT: reuses `toResidentAppointmentDto` — the exact DTO the Case
 *    detail route already hands a Resident — instead of a second narrowing,
 *    and nulls `operationId` to match (that DTO drops it too).
 *  - PROOF_ITEM: `contractorId` names who uploaded the item — a Resident
 *    seeing which Contractor across a reassignment is the same churn leak by
 *    another route.
 * Exhaustive over every source for the same reason `includeTimelineEventForRole`
 * is: a source a Resident can newly reach but this switch does not name
 * fails to compile rather than passing its raw `detail` through unredacted.
 *
 * `detail` is `unknown` by contract, so every case below narrows it at
 * runtime instead of asserting its shape — an assertion that turns out
 * wrong either degrades silently (spreading a non-object yields no own
 * properties) or throws mid-request. Neither is acceptable here: on a
 * guard failure this redacts harder, not softer, and sets `detail: null`.
 * Showing a Resident less than intended is a cosmetic bug; showing them
 * more is the exact class of defect this whole sub-issue exists to close.
 */
function redactForResident(event: TimelineEvent): TimelineEvent {
  switch (event.source) {
    case "CASE_HISTORY":
      return {
        ...event,
        actorId: null,
        operationId: null,
        detail: isPlainRecord(event.detail)
          ? { ...event.detail, actorId: null, operationId: null }
          : null,
      };
    case "APPOINTMENT": {
      const appointment = AppointmentDtoSchema.safeParse(event.detail);
      return {
        ...event,
        operationId: null,
        detail: appointment.success
          ? toResidentAppointmentDto(appointment.data)
          : null,
      };
    }
    case "PROOF_ITEM":
      return {
        ...event,
        detail: isPlainRecord(event.detail)
          ? { ...event.detail, contractorId: null }
          : null,
      };
    case "DERIVED_EFFECT":
      // EMAIL-only by the time a Resident sees this — `includeTimelineEventForRole`
      // already drops PERFORMANCE_ENTRY — and an EMAIL summary's
      // `contractorId` is already null (151-A), so there is nothing to redact.
      return event;
    case "ALLOCATION_ATTEMPT":
    case "ASSIGNMENT_STATUS":
    case "OFFICER_ATTENTION":
      // Unreachable for a Resident — `includeTimelineEventForRole` already
      // drops all three — kept here only so this switch stays exhaustive
      // against the full `TimelineEventSource` union.
      return event;
    default: {
      const unhandledSource: never = event.source;
      throw new Error(`Unhandled timeline source: ${String(unhandledSource)}`);
    }
  }
}

/**
 * Rows from different atoms collide on timestamp routinely (a Case-atom
 * write and an Attempt insert in the same request, for instance) — sorting
 * by `at` alone is not a total order. `(at, source, id)` is: ties resolve
 * deterministically instead of however the fan-out happened to settle.
 * `Date.parse` on a malformed `at` falls back to a string compare so the
 * sort never sees `NaN`, which fails every comparison.
 */
function compareTimelineEvents(a: TimelineEvent, b: TimelineEvent) {
  const atA = Date.parse(a.at);
  const atB = Date.parse(b.at);
  const byTime =
    Number.isNaN(atA) || Number.isNaN(atB)
      ? a.at.localeCompare(b.at)
      : atA - atB;
  if (byTime !== 0) return byTime;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── Case detail full-history sections (PRS-151 151-D, Tasks 1 & 3) ───────
// Officer and Contractor detail both gain the same four sections — full
// Allocation Attempt history, Appointment history, Proof Items, and Derived
// Effects — reusing the exact per-source fetchers the timeline above already
// built, rather than a fourth set of atom calls.

/**
 * Runs a source's `TimelineEvent[]` through `includeTimelineEventForRole` —
 * the same participation predicate the timeline uses, not a second copy of
 * the CURRENT/HISTORICAL rule (151-D Task 3) — then unwraps each surviving
 * event back to its typed DTO via `.detail`, which every `*Event()` mapper
 * above sets to exactly that DTO. `detail` is `unknown` by contract, so this
 * re-parses rather than casts; a row that fails to parse is dropped, the
 * same defensive default the mappers above already use. Officer's
 * `participation` is always null, under which every source passes
 * unconditionally (`includeTimelineEventForRole`'s OFFICER branch), so this
 * same call is a no-op filter for an Officer and the real narrowing for a
 * HISTORICAL Contractor.
 */
function caseDetailSection<T>(
  events: TimelineEvent[],
  actor: Actor,
  participation: "CURRENT" | "HISTORICAL" | null,
  schema: z.ZodType<T>
): T[] {
  return events
    .filter((event) => includeTimelineEventForRole(event, actor, participation))
    .flatMap((event) => {
      const parsed = schema.safeParse(event.detail);
      return parsed.success ? [parsed.data] : [];
    });
}

export function createGatewayApp({
  workflowClient,
  caseAtomUrl,
  residentAtomUrl,
  authAtomUrl,
  assignmentAtomUrl = "http://localhost:5004",
  appointmentAtomUrl = "http://localhost:5003",
  proofAtomUrl = "http://localhost:5007",
  alertAtomUrl = "http://localhost:5002",
  workerServiceToken = "",
  authenticate,
  fetchImpl: rawFetchImpl = fetch,
  updateTimeoutMs = 20_000,
}: GatewayDependencies) {
  const app = new Hono<GatewayEnv>();
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${workerServiceToken}`);
    return rawFetchImpl(input, { ...init, headers });
  };

  // A thrown HTTPException (e.g. the `jwk` authenticate middleware on a
  // missing/invalid token) already carries its own correct response —
  // Hono's own default handler special-cases it the same way — so this only
  // takes over for what would otherwise be Hono's plaintext 500: a stray
  // `.parse()` throw (CaseStatusSchema, most often) escaping a handler.
  // AC1 requires the common error envelope on every read, this included.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // The Gateway carries no logger (unlike the atoms' shared-ts logger +
    // Sentry) — 151-B deliberately does not add that dependency here.
    console.error("[gateway] internal server error", {
      error: err.message,
      stack: err.stack,
      route: c.req.path,
    });
    return error(c, 500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      retryable: false,
    });
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (browserOrigins.has(origin) ? origin : undefined),
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      credentials: true,
      exposeHeaders: ["Retry-After"],
    })
  );

  app.all("/api/auth/*", async (c) => {
    const url = new URL(c.req.url);
    const target = `${authAtomUrl}${url.pathname}${url.search}`;

    const headers = new Headers();
    for (const name of ["content-type", "authorization", "cookie", "origin"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }

    const method = c.req.method;
    const body =
      method === "GET" || method === "HEAD" ? undefined : await c.req.text();

    let upstream: Response;
    try {
      upstream = await rawFetchImpl(target, { method, headers, body });
    } catch {
      return error(c, 503, {
        code: "AUTH_ATOM_UNAVAILABLE",
        message: "Auth service is unavailable",
        retryable: true,
      });
    }

    const responseText = await upstream.text();

    if (upstream.ok && /\/sign-(up|in)\b/.test(url.pathname)) {
      try {
        const parsed = authResponseSchema.safeParse(JSON.parse(responseText));
        if (
          parsed.success &&
          parsed.data.user.role.toUpperCase() === "RESIDENT"
        ) {
          ensureResidentProvisioning(workflowClient, {
            accountId: parsed.data.user.id,
            name: parsed.data.user.name,
            email: parsed.data.user.email,
          });
        }
      } catch {
        // Best-effort — an unparsable body never blocks the proxied response.
      }
    }

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    for (const cookie of upstream.headers.getSetCookie()) {
      responseHeaders.append("set-cookie", cookie);
    }

    return new Response(responseText, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

  if (authenticate) app.use("/api/*", authenticate);

  app.get("/api/me", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }

    if (actor.role !== "RESIDENT") {
      return c.json({
        data: MeDtoSchema.parse({
          accountId: actor.accountId,
          role: actor.role,
          residentId: null,
          contractorId: actor.contractorId,
          provisioningState: "NOT_APPLICABLE",
          canOpenCases: actor.role === "OFFICER",
        }),
      });
    }

    const lookup = await lookupResidentProfile(
      residentAtomUrl,
      fetchImpl,
      actor.accountId
    );
    if (lookup.status === "UNAVAILABLE") {
      return error(c, 503, {
        code: "RESIDENT_ATOM_UNAVAILABLE",
        message: "Resident service is unavailable",
        retryable: true,
      });
    }

    if (lookup.status === "ABSENT") {
      ensureResidentProvisioning(workflowClient, actor);
      return c.json({
        data: MeDtoSchema.parse({
          accountId: actor.accountId,
          role: actor.role,
          residentId: null,
          contractorId: actor.contractorId,
          provisioningState: "PROVISIONING",
          canOpenCases: false,
        }),
      });
    }

    return c.json({
      data: MeDtoSchema.parse({
        accountId: actor.accountId,
        role: actor.role,
        residentId: actor.accountId,
        contractorId: actor.contractorId,
        provisioningState: "PROVISIONED",
        canOpenCases: true,
      }),
    });
  });

  app.post("/api/cases", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "RESIDENT" && actor.role !== "OFFICER") {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Resident or Officer access is required",
        retryable: false,
      });
    }

    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key")
    );
    if (!idempotencyKey.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key must be a UUID",
        retryable: false,
      });
    }

    const json = await c.req.json().catch(() => undefined);
    let input: OpenCaseInput;

    if (actor.role === "OFFICER") {
      const body = OpenCaseInputSchema.safeParse(json);
      if (!body.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case opening input is invalid",
          retryable: false,
          details: body.error.flatten(),
        });
      }
      input = body.data;
    } else {
      const body = ResidentOpenCaseInputSchema.safeParse(json);
      if (!body.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case opening input is invalid",
          retryable: false,
          details: body.error.flatten(),
        });
      }

      const lookup = await lookupResidentProfile(
        residentAtomUrl,
        fetchImpl,
        actor.accountId
      );
      if (lookup.status === "UNAVAILABLE") {
        return error(c, 503, {
          code: "RESIDENT_ATOM_UNAVAILABLE",
          message: "Resident service is unavailable",
          retryable: true,
        });
      }
      if (lookup.status === "ABSENT") {
        ensureResidentProvisioning(workflowClient, actor);
        return error(c, 409, {
          code: "RESIDENT_PROFILE_PROVISIONING",
          message: "Resident profile is still being provisioned",
          retryable: true,
        });
      }

      input = { ...body.data, residentId: actor.accountId };
    }

    const operation = operationFor(
      idempotencyKey.data,
      canonicalOpenCasePayload(input)
    );
    const startWorkflowOperation = new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: operation.workflowId,
        taskQueue: ORCHESTRATION_TASK_QUEUE,
        args: [{ caseId: operation.caseId }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    );
    const update = workflowClient.executeUpdateWithStart(
      UPDATE_NAMES.openCase,
      {
        args: [
          {
            idempotencyKey: operation.idempotencyKey,
            payloadHash: operation.updateId.slice(
              operation.idempotencyKey.length + 1
            ),
            operationId: operation.updateId,
            actorId: actor.accountId,
            actorRole: actor.role,
            input,
          },
        ],
        updateId: operation.updateId,
        startWorkflowOperation,
      }
    );
    void update.catch(() => undefined);

    let result: OpenCaseResult;
    try {
      result = OpenCaseResultSchema.parse(
        await withTimeout(update, updateTimeoutMs)
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.message === "workflow update timed out"
      ) {
        c.header("Retry-After", "2");
        return error(c, 504, {
          code: "WORKFLOW_UPDATE_PENDING",
          message: "Case opening is still being processed",
          retryable: true,
          operation,
        });
      }
      if (isTemporalUnavailable(caught)) {
        return error(c, 503, {
          code: "TEMPORAL_UNAVAILABLE",
          message: "Case workflow service is unavailable",
          retryable: true,
          operation,
        });
      }
      return error(c, 500, {
        code: "WORKFLOW_UPDATE_FAILED",
        message: "Case opening could not be completed",
        retryable: false,
        operation,
      });
    }

    if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
      return error(c, 409, {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key was already used with a different request",
        retryable: false,
        operation,
      });
    }

    return c.json({ data: result.data, operation }, 201);
  });

  app.put("/api/cases/:caseId/cancel", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "RESIDENT" && actor.role !== "OFFICER") {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Resident or Officer access is required",
        retryable: false,
      });
    }

    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!caseId.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    }
    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key")
    );
    if (!idempotencyKey.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key must be a UUID",
        retryable: false,
      });
    }
    const input = CancelCaseInputSchema.safeParse(
      await c.req.json().catch(() => undefined)
    );
    if (!input.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Cancellation reason is invalid",
        retryable: false,
        details: input.error.flatten(),
      });
    }

    let caseResponse: Response;
    try {
      caseResponse = await fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`);
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!caseResponse.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const parsedCase = caseAtomResponseSchema.safeParse(
      await caseResponse.json().catch(() => undefined)
    );
    if (!parsedCase.success || parsedCase.data.cases.length === 0) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    const caseDto = toCaseDto(parsedCase.data.cases[0]);
    if (actor.role === "RESIDENT" && caseDto.residentId !== actor.accountId) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    if (
      caseDto.status === "IN_PROGRESS" ||
      caseDto.status === "COMPLETED" ||
      caseDto.status === "CANCELLED"
    ) {
      return error(c, 409, {
        code: "NOT_CANCELLABLE",
        message: "Case cancellation is not available",
        retryable: false,
      });
    }

    const operation = operationForCase(
      caseId.data,
      idempotencyKey.data,
      canonicalCancelCasePayload(caseId.data, input.data)
    );
    const startWorkflowOperation = new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: operation.workflowId,
        taskQueue: ORCHESTRATION_TASK_QUEUE,
        args: [{ caseId: caseId.data }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    );
    const update = workflowClient.executeUpdateWithStart(
      UPDATE_NAMES.cancelCase,
      {
        args: [
          {
            idempotencyKey: operation.idempotencyKey,
            payloadHash: operation.updateId.slice(
              operation.idempotencyKey.length + 1
            ),
            operationId: operation.updateId,
            actorId: actor.accountId,
            actorRole: actor.role,
            caseId: caseId.data,
            input: input.data,
          },
        ],
        updateId: operation.updateId,
        startWorkflowOperation,
      }
    );
    void update.catch(() => undefined);

    let result: CancelCaseResult;
    try {
      result = CancelCaseResultSchema.parse(
        await withTimeout(update, updateTimeoutMs)
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.message === "workflow update timed out"
      ) {
        c.header("Retry-After", "2");
        return error(c, 504, {
          code: "WORKFLOW_UPDATE_PENDING",
          message: "Case cancellation is still being processed",
          retryable: true,
          operation,
        });
      }
      if (isTemporalUnavailable(caught)) {
        return error(c, 503, {
          code: "TEMPORAL_UNAVAILABLE",
          message: "Case workflow service is unavailable",
          retryable: true,
          operation,
        });
      }
      return error(c, 500, {
        code: "WORKFLOW_UPDATE_FAILED",
        message: "Case cancellation could not be completed",
        retryable: false,
        operation,
      });
    }

    if (result.kind === "SUCCESS") {
      return c.json({ data: result.data, operation }, 200);
    }
    if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
      return error(c, 409, {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key was already used with a different request",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "CASE_MISMATCH") {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
        operation,
      });
    }
    return error(c, 409, {
      code: "NOT_CANCELLABLE",
      message: "Case cancellation is not available",
      retryable: false,
      operation,
    });
  });

  app.put(
    "/api/cases/:caseId/allocation-attempts/:attemptId/acceptance",
    async (c) => {
      const actor = resolveActor(c.get("jwtPayload"));
      if (!actor) {
        return error(c, 401, {
          code: "INVALID_TOKEN",
          message: "Token subject is invalid",
          retryable: false,
        });
      }
      const contractorId = z.uuid().safeParse(actor.contractorId);
      if (actor.role !== "CONTRACTOR" || !contractorId.success) {
        return error(c, 403, {
          code: "FORBIDDEN",
          message: "Contractor access is required",
          retryable: false,
        });
      }

      const caseId = z.uuid().safeParse(c.req.param("caseId"));
      const attemptId = z.uuid().safeParse(c.req.param("attemptId"));
      if (!caseId.success || !attemptId.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case ID and Allocation Attempt ID must be UUIDs",
          retryable: false,
        });
      }
      const idempotencyKey = idempotencyKeySchema.safeParse(
        c.req.header("Idempotency-Key")
      );
      if (!idempotencyKey.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Idempotency-Key must be a UUID",
          retryable: false,
        });
      }
      const input = AcceptAllocationInputSchema.safeParse(
        await c.req.json().catch(() => undefined)
      );
      if (!input.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Appointment interval is invalid",
          retryable: false,
          details: input.error.flatten(),
        });
      }
      const caseAssignment = found(
        await lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data)
      );
      if (
        !caseAssignment ||
        !caseAssignment.currentAttempt ||
        caseAssignment.currentAttempt.id !== attemptId.data ||
        caseAssignment.currentAttempt.contractorId !== contractorId.data
      ) {
        return error(c, 404, {
          code: "ALLOCATION_ATTEMPT_NOT_FOUND",
          message: "Allocation Attempt was not found",
          retryable: false,
        });
      }

      const operation = operationForCase(
        caseId.data,
        idempotencyKey.data,
        canonicalAcceptAllocationPayload(
          caseId.data,
          attemptId.data,
          input.data
        )
      );
      const startWorkflowOperation = new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: operation.workflowId,
          taskQueue: ORCHESTRATION_TASK_QUEUE,
          args: [{ caseId: caseId.data }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      );
      const update = workflowClient.executeUpdateWithStart(
        UPDATE_NAMES.acceptAllocation,
        {
          args: [
            {
              idempotencyKey: operation.idempotencyKey,
              payloadHash: operation.updateId.slice(
                operation.idempotencyKey.length + 1
              ),
              operationId: operation.updateId,
              actorId: actor.accountId,
              actorRole: "CONTRACTOR",
              contractorId: contractorId.data,
              caseId: caseId.data,
              assignmentId: caseAssignment.assignment.id,
              attemptId: attemptId.data,
              input: input.data,
            },
          ],
          updateId: operation.updateId,
          startWorkflowOperation,
        }
      );
      void update.catch(() => undefined);

      let result: AcceptAllocationResult;
      try {
        result = AcceptAllocationResultSchema.parse(
          await withTimeout(update, updateTimeoutMs)
        );
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "workflow update timed out"
        ) {
          c.header("Retry-After", "2");
          return error(c, 504, {
            code: "WORKFLOW_UPDATE_PENDING",
            message: "Allocation acceptance is still being processed",
            retryable: true,
            operation,
          });
        }
        if (isTemporalUnavailable(caught)) {
          return error(c, 503, {
            code: "TEMPORAL_UNAVAILABLE",
            message: "Case workflow service is unavailable",
            retryable: true,
            operation,
          });
        }
        return error(c, 500, {
          code: "WORKFLOW_UPDATE_FAILED",
          message: "Allocation acceptance could not be completed",
          retryable: false,
          operation,
        });
      }

      if (result.kind === "SUCCESS") {
        return c.json({ data: result.data, operation }, 200);
      }
      if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
        return error(c, 409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "Idempotency-Key was already used with a different request",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "APPOINTMENT_CONFLICT") {
        return error(c, 409, {
          code: "APPOINTMENT_CONFLICT",
          message: "The requested appointment slot is unavailable",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "APPOINTMENT_NOT_FUTURE") {
        return error(c, 400, {
          code: "APPOINTMENT_NOT_FUTURE",
          message: "Appointment start time must be in the future",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "CASE_MISMATCH") {
        return error(c, 404, {
          code: "ALLOCATION_ATTEMPT_NOT_FOUND",
          message: "Allocation Attempt was not found",
          retryable: false,
          operation,
        });
      }
      return error(c, 409, {
        code: result.kind,
        message: "Allocation Attempt is no longer available for acceptance",
        retryable: false,
        operation,
      });
    }
  );

  app.put(
    "/api/cases/:caseId/appointments/:appointmentId/start-work",
    async (c) => {
      const actor = resolveActor(c.get("jwtPayload"));
      if (!actor) {
        return error(c, 401, {
          code: "INVALID_TOKEN",
          message: "Token subject is invalid",
          retryable: false,
        });
      }
      const contractorId = z.uuid().safeParse(actor.contractorId);
      if (actor.role !== "CONTRACTOR" || !contractorId.success) {
        return error(c, 403, {
          code: "FORBIDDEN",
          message: "Contractor access is required",
          retryable: false,
        });
      }

      const caseId = z.uuid().safeParse(c.req.param("caseId"));
      const appointmentId = z.uuid().safeParse(c.req.param("appointmentId"));
      if (!caseId.success || !appointmentId.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case ID and Appointment ID must be UUIDs",
          retryable: false,
        });
      }
      const idempotencyKey = idempotencyKeySchema.safeParse(
        c.req.header("Idempotency-Key")
      );
      if (!idempotencyKey.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Idempotency-Key must be a UUID",
          retryable: false,
        });
      }

      const currentAppointment = await lookupCurrentAppointment(
        appointmentAtomUrl,
        fetchImpl,
        caseId.data,
        appointmentId.data
      );
      if (
        !currentAppointment ||
        currentAppointment.contractorId !== contractorId.data
      ) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
        });
      }

      const operation = operationForCase(
        caseId.data,
        idempotencyKey.data,
        canonicalStartWorkPayload(caseId.data, appointmentId.data)
      );
      const startWorkflowOperation = new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: operation.workflowId,
          taskQueue: ORCHESTRATION_TASK_QUEUE,
          args: [{ caseId: caseId.data }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      );
      const update = workflowClient.executeUpdateWithStart(
        UPDATE_NAMES.startWork,
        {
          args: [
            {
              idempotencyKey: operation.idempotencyKey,
              payloadHash: operation.updateId.slice(
                operation.idempotencyKey.length + 1
              ),
              operationId: operation.updateId,
              actorId: actor.accountId,
              actorRole: "CONTRACTOR",
              contractorId: contractorId.data,
              caseId: caseId.data,
              assignmentId: currentAppointment.assignmentId,
              appointmentId: appointmentId.data,
              startTime: currentAppointment.startTime,
              endTime: currentAppointment.endTime,
            },
          ],
          updateId: operation.updateId,
          startWorkflowOperation,
        }
      );
      void update.catch(() => undefined);

      let result: StartWorkResult;
      try {
        result = StartWorkResultSchema.parse(
          await withTimeout(update, updateTimeoutMs)
        );
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "workflow update timed out"
        ) {
          c.header("Retry-After", "2");
          return error(c, 504, {
            code: "WORKFLOW_UPDATE_PENDING",
            message: "Work start is still being processed",
            retryable: true,
            operation,
          });
        }
        if (isTemporalUnavailable(caught)) {
          return error(c, 503, {
            code: "TEMPORAL_UNAVAILABLE",
            message: "Case workflow service is unavailable",
            retryable: true,
            operation,
          });
        }
        return error(c, 500, {
          code: "WORKFLOW_UPDATE_FAILED",
          message: "Work start could not be completed",
          retryable: false,
          operation,
        });
      }

      if (result.kind === "SUCCESS") {
        return c.json({ data: result.data, operation }, 200);
      }
      if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
        return error(c, 409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "Idempotency-Key was already used with a different request",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "NOT_IN_WINDOW") {
        return error(c, 409, {
          code: "APPOINTMENT_NOT_IN_PROGRESS_WINDOW",
          message: "Work can only start during the Appointment interval",
          retryable: false,
          operation,
        });
      }
      if (
        result.kind === "WRONG_CONTRACTOR" ||
        result.kind === "APPOINTMENT_MISMATCH" ||
        result.kind === "CASE_MISMATCH"
      ) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
          operation,
        });
      }
      // NOT_SCHEDULED is a clean domain rejection; WORK_START_FAILED means an
      // Officer Attention was raised after the Appointment already started.
      // CASE_TERMINAL / NOT_ACCEPTED are unreachable in practice — the Worker
      // collapses both into WORK_START_FAILED — kept here only so this stays
      // exhaustive against the contract union.
      return error(c, 409, {
        code: result.kind,
        message: "Work could not be started for this Appointment",
        retryable: false,
        operation,
      });
    }
  );

  app.put(
    "/api/cases/:caseId/appointments/:appointmentId/no-access",
    async (c) => {
      const actor = resolveActor(c.get("jwtPayload"));
      if (!actor) {
        return error(c, 401, {
          code: "INVALID_TOKEN",
          message: "Token subject is invalid",
          retryable: false,
        });
      }
      const contractorId = z.uuid().safeParse(actor.contractorId);
      if (actor.role !== "CONTRACTOR" || !contractorId.success) {
        return error(c, 403, {
          code: "FORBIDDEN",
          message: "Contractor access is required",
          retryable: false,
        });
      }

      const caseId = z.uuid().safeParse(c.req.param("caseId"));
      const appointmentId = z.uuid().safeParse(c.req.param("appointmentId"));
      if (!caseId.success || !appointmentId.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case ID and Appointment ID must be UUIDs",
          retryable: false,
        });
      }
      const idempotencyKey = idempotencyKeySchema.safeParse(
        c.req.header("Idempotency-Key")
      );
      if (!idempotencyKey.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Idempotency-Key must be a UUID",
          retryable: false,
        });
      }
      if (await c.req.text()) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "No Access does not accept a request body",
          retryable: false,
        });
      }

      const currentAppointment = await lookupCurrentAppointment(
        appointmentAtomUrl,
        fetchImpl,
        caseId.data,
        appointmentId.data
      );
      if (
        !currentAppointment ||
        currentAppointment.contractorId !== contractorId.data
      ) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
        });
      }

      const operation = operationForCase(
        caseId.data,
        idempotencyKey.data,
        canonicalReportNoAccessPayload(caseId.data, appointmentId.data)
      );
      const startWorkflowOperation = new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: operation.workflowId,
          taskQueue: ORCHESTRATION_TASK_QUEUE,
          args: [{ caseId: caseId.data }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      );
      const update = workflowClient.executeUpdateWithStart(
        UPDATE_NAMES.reportNoAccess,
        {
          args: [
            {
              idempotencyKey: operation.idempotencyKey,
              payloadHash: operation.updateId.slice(
                operation.idempotencyKey.length + 1
              ),
              operationId: operation.updateId,
              actorId: actor.accountId,
              actorRole: "CONTRACTOR",
              contractorId: contractorId.data,
              caseId: caseId.data,
              appointmentId: appointmentId.data,
              startTime: currentAppointment.startTime,
              endTime: currentAppointment.endTime,
            },
          ],
          updateId: operation.updateId,
          startWorkflowOperation,
        }
      );
      void update.catch(() => undefined);

      let result: ReportNoAccessResult;
      try {
        result = ReportNoAccessResultSchema.parse(
          await withTimeout(update, updateTimeoutMs)
        );
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "workflow update timed out"
        ) {
          c.header("Retry-After", "2");
          return error(c, 504, {
            code: "WORKFLOW_UPDATE_PENDING",
            message: "No Access is still being processed",
            retryable: true,
            operation,
          });
        }
        if (isTemporalUnavailable(caught)) {
          return error(c, 503, {
            code: "TEMPORAL_UNAVAILABLE",
            message: "Case workflow service is unavailable",
            retryable: true,
            operation,
          });
        }
        return error(c, 500, {
          code: "WORKFLOW_UPDATE_FAILED",
          message: "No Access could not be recorded",
          retryable: false,
          operation,
        });
      }

      if (result.kind === "SUCCESS") {
        return c.json({ data: result.data, operation }, 200);
      }
      if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
        return error(c, 409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "Idempotency-Key was already used with a different request",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "NOT_IN_WINDOW") {
        return error(c, 409, {
          code: "APPOINTMENT_NOT_IN_PROGRESS_WINDOW",
          message: "No Access can only be reported during the Appointment",
          retryable: false,
          operation,
        });
      }
      if (
        result.kind === "WRONG_CONTRACTOR" ||
        result.kind === "APPOINTMENT_MISMATCH" ||
        result.kind === "CASE_MISMATCH"
      ) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
          operation,
        });
      }
      // NOT_SCHEDULED (work already started, or the Appointment was retired)
      // and CASE_TERMINAL are both clean domain rejections.
      return error(c, 409, {
        code: result.kind,
        message: "No Access could not be reported for this Appointment",
        retryable: false,
        operation,
      });
    }
  );

  app.put(
    "/api/cases/:caseId/appointments/:appointmentId/replacement",
    async (c) => {
      const actor = resolveActor(c.get("jwtPayload"));
      if (!actor) {
        return error(c, 401, {
          code: "INVALID_TOKEN",
          message: "Token subject is invalid",
          retryable: false,
        });
      }
      // AC8: a Contractor cannot reschedule through the public API — only the
      // Resident who owns the Case, or an Officer.
      if (actor.role !== "RESIDENT" && actor.role !== "OFFICER") {
        return error(c, 403, {
          code: "FORBIDDEN",
          message: "Resident or Officer access is required",
          retryable: false,
        });
      }

      const caseId = z.uuid().safeParse(c.req.param("caseId"));
      const appointmentId = z.uuid().safeParse(c.req.param("appointmentId"));
      if (!caseId.success || !appointmentId.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case ID and Appointment ID must be UUIDs",
          retryable: false,
        });
      }
      const idempotencyKey = idempotencyKeySchema.safeParse(
        c.req.header("Idempotency-Key")
      );
      if (!idempotencyKey.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Idempotency-Key must be a UUID",
          retryable: false,
        });
      }
      const input = ReplaceAppointmentInputSchema.safeParse(
        await c.req.json().catch(() => undefined)
      );
      if (!input.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Replacement Appointment input is invalid",
          retryable: false,
          details: input.error.flatten(),
        });
      }

      // AC3: a Resident's authority comes from owning the Case, derived from
      // the token rather than trusted from the request. A non-owner gets the
      // same 404 as GET /api/cases/:caseId, so the route never confirms that
      // somebody else's Case exists.
      if (actor.role === "RESIDENT") {
        let caseResponse: Response;
        try {
          caseResponse = await fetchImpl(
            `${caseAtomUrl}/api/cases/${caseId.data}`
          );
        } catch {
          return error(c, 503, {
            code: "CASE_ATOM_UNAVAILABLE",
            message: "Case service is unavailable",
            retryable: true,
          });
        }
        if (!caseResponse.ok) {
          return error(c, 503, {
            code: "CASE_ATOM_UNAVAILABLE",
            message: "Case service is unavailable",
            retryable: true,
          });
        }
        const parsedCase = caseAtomResponseSchema.safeParse(
          await caseResponse.json().catch(() => undefined)
        );
        if (
          !parsedCase.success ||
          parsedCase.data.cases.length === 0 ||
          toCaseDto(parsedCase.data.cases[0]).residentId !== actor.accountId
        ) {
          return error(c, 404, {
            code: "CASE_NOT_FOUND",
            message: "Case was not found",
            retryable: false,
          });
        }
      }

      const currentAppointment = await lookupCurrentAppointment(
        appointmentAtomUrl,
        fetchImpl,
        caseId.data,
        appointmentId.data
      );
      if (!currentAppointment) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
        });
      }

      // AC4: moving a still-live Appointment must say why. Recovering one that
      // is already NO_ACCESS (AC5) need not — the Contractor has recorded why
      // the visit failed. The status is the one the lookup above just derived,
      // never one the caller sent: a request-supplied status would let any
      // caller claim NO_ACCESS and skip the reason entirely.
      if (currentAppointment.status === "SCHEDULED" && !input.data.reason) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "A reason is required to reschedule a live Appointment",
          retryable: false,
        });
      }

      const operation = operationForCase(
        caseId.data,
        idempotencyKey.data,
        canonicalReplaceAppointmentPayload(
          caseId.data,
          appointmentId.data,
          input.data
        )
      );
      const startWorkflowOperation = new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: operation.workflowId,
          taskQueue: ORCHESTRATION_TASK_QUEUE,
          args: [{ caseId: caseId.data }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      );
      const update = workflowClient.executeUpdateWithStart(
        UPDATE_NAMES.replaceAppointment,
        {
          args: [
            {
              idempotencyKey: operation.idempotencyKey,
              payloadHash: operation.updateId.slice(
                operation.idempotencyKey.length + 1
              ),
              operationId: operation.updateId,
              actorId: actor.accountId,
              actorRole: actor.role,
              caseId: caseId.data,
              appointmentId: appointmentId.data,
              input: input.data,
              // The Workflow's AC4 gate needs the Appointment being replaced;
              // it cannot read it, so the pre-check above supplies it.
              previousStartTime: currentAppointment.startTime,
              previousStatus: currentAppointment.status,
            },
          ],
          updateId: operation.updateId,
          startWorkflowOperation,
        }
      );
      void update.catch(() => undefined);

      let result: ReplaceAppointmentResult;
      try {
        result = ReplaceAppointmentResultSchema.parse(
          await withTimeout(update, updateTimeoutMs)
        );
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "workflow update timed out"
        ) {
          c.header("Retry-After", "2");
          return error(c, 504, {
            code: "WORKFLOW_UPDATE_PENDING",
            message: "The reschedule is still being processed",
            retryable: true,
            operation,
          });
        }
        if (isTemporalUnavailable(caught)) {
          return error(c, 503, {
            code: "TEMPORAL_UNAVAILABLE",
            message: "Case workflow service is unavailable",
            retryable: true,
            operation,
          });
        }
        return error(c, 500, {
          code: "WORKFLOW_UPDATE_FAILED",
          message: "The reschedule could not be completed",
          retryable: false,
          operation,
        });
      }

      if (result.kind === "SUCCESS") {
        const data =
          actor.role === "RESIDENT"
            ? {
                ...result.data,
                appointment: toResidentAppointmentDto(result.data.appointment),
              }
            : result.data;
        return c.json({ data, operation }, 200);
      }
      if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
        return error(c, 409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "Idempotency-Key was already used with a different request",
          retryable: false,
          operation,
        });
      }
      if (result.kind === "APPOINTMENT_CONFLICT") {
        return error(c, 409, {
          code: "APPOINTMENT_CONFLICT",
          message: "The requested appointment slot is unavailable",
          retryable: false,
          operation,
        });
      }
      if (
        result.kind === "APPOINTMENT_MISMATCH" ||
        result.kind === "CASE_MISMATCH"
      ) {
        return error(c, 404, {
          code: "APPOINTMENT_NOT_FOUND",
          message: "Appointment was not found",
          retryable: false,
          operation,
        });
      }
      // NOT_FUTURE (the new slot, or a still-scheduled old one, is not in the
      // future), NOT_REPLACEABLE and CASE_TERMINAL are clean domain
      // rejections.
      return error(c, 409, {
        code: result.kind,
        message: "The Appointment could not be replaced",
        retryable: false,
        operation,
      });
    }
  );

  app.post("/api/cases/:caseId/allocation-attempts", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "OFFICER") {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Officer access is required",
        retryable: false,
      });
    }

    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!caseId.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    }
    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key")
    );
    if (!idempotencyKey.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key must be a UUID",
        retryable: false,
      });
    }
    const body = ManualAllocationInputSchema.safeParse(
      await c.req.json().catch(() => undefined)
    );
    if (!body.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Manual allocation input is invalid",
        retryable: false,
        details: body.error.flatten(),
      });
    }

    let caseResponse: Response;
    try {
      caseResponse = await fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`);
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!caseResponse.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const parsedCase = caseAtomResponseSchema.safeParse(
      await caseResponse.json().catch(() => undefined)
    );
    if (!parsedCase.success || parsedCase.data.cases.length === 0) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    const caseDto = toCaseDto(parsedCase.data.cases[0]);
    if (caseDto.status !== "PENDING" && caseDto.status !== "ASSIGNED") {
      return error(c, 409, {
        code: "CASE_NOT_ALLOCATABLE",
        message:
          "Case cannot receive an Allocation Attempt in its current state",
        retryable: false,
      });
    }

    const operation = operationForCase(
      caseId.data,
      idempotencyKey.data,
      canonicalManualAllocationPayload(caseId.data, body.data)
    );
    const startWorkflowOperation = new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: operation.workflowId,
        taskQueue: ORCHESTRATION_TASK_QUEUE,
        args: [{ caseId: caseId.data }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    );
    const update = workflowClient.executeUpdateWithStart(
      UPDATE_NAMES.allocateContractor,
      {
        args: [
          {
            idempotencyKey: operation.idempotencyKey,
            payloadHash: operation.updateId.slice(
              operation.idempotencyKey.length + 1
            ),
            operationId: operation.updateId,
            actorId: actor.accountId,
            actorRole: "OFFICER",
            caseId: caseId.data,
            category: caseDto.category,
            postalCode: caseDto.postalCode,
            input: body.data,
          },
        ],
        updateId: operation.updateId,
        startWorkflowOperation,
      }
    );
    void update.catch(() => undefined);

    let result: ManualAllocationResult;
    try {
      result = ManualAllocationResultSchema.parse(
        await withTimeout(update, updateTimeoutMs)
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.message === "workflow update timed out"
      ) {
        c.header("Retry-After", "2");
        return error(c, 504, {
          code: "WORKFLOW_UPDATE_PENDING",
          message: "Manual allocation is still being processed",
          retryable: true,
          operation,
        });
      }
      if (isTemporalUnavailable(caught)) {
        return error(c, 503, {
          code: "TEMPORAL_UNAVAILABLE",
          message: "Case workflow service is unavailable",
          retryable: true,
          operation,
        });
      }
      return error(c, 500, {
        code: "WORKFLOW_UPDATE_FAILED",
        message: "Manual allocation could not be completed",
        retryable: false,
        operation,
      });
    }

    if (result.kind === "SUCCESS") {
      return c.json({ data: result.data, operation }, 201);
    }
    if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
      return error(c, 409, {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key was already used with a different request",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "CONTRACTOR_NOT_ELIGIBLE") {
      return error(c, 409, {
        code: "CONTRACTOR_NOT_ELIGIBLE",
        message: "Contractor is not eligible for this Case",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "ACTIVE_ATTEMPT_EXISTS") {
      return error(c, 409, {
        code: "ACTIVE_ALLOCATION_ATTEMPT_EXISTS",
        message: "Another Allocation Attempt already won this race",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "REPLACEMENT_ATTEMPT_NOT_PENDING") {
      return error(c, 409, {
        code: "REPLACEMENT_ATTEMPT_NOT_PENDING",
        message: "The named Allocation Attempt is not pending",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "OVERRIDE_REASON_REQUIRED") {
      return error(c, 400, {
        code: "OVERRIDE_REASON_REQUIRED",
        message:
          "A reason is required to reassign a Contractor who already breached on this Case",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "CASE_TERMINAL") {
      return error(c, 409, {
        code: "CASE_TERMINAL",
        message: "The Case is already completed or cancelled",
        retryable: false,
        operation,
      });
    }
    return error(c, 500, {
      code: "ALLOCATION_FAILED",
      message: result.reason,
      retryable: false,
      operation,
    });
  });

  app.get("/api/officer-attention", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "OFFICER") {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Officer access is required",
        retryable: false,
      });
    }
    const query = z
      .object({
        state: z.enum(["open", "resolved"]).default("open"),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(100).default(25),
        // 151-A added this filter to the atom; 151-D Task 4 wires it through.
        caseId: z.uuid().optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Officer Attention pagination is invalid",
        retryable: false,
        details: query.error.flatten(),
      });
    }

    const officerAttentionParams = new URLSearchParams({
      state: query.data.state,
      page: String(query.data.page),
      pageSize: String(query.data.pageSize),
    });
    if (query.data.caseId) {
      officerAttentionParams.set("caseId", query.data.caseId);
    }

    let response: Response;
    try {
      response = await fetchImpl(
        `${caseAtomUrl}/api/cases/officer-attention?${officerAttentionParams}`
      );
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!response.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const parsed = officerAttentionAtomResponseSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!parsed.success) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service returned an invalid Officer Attention response",
        retryable: true,
      });
    }
    return c.json({ data: { items: parsed.data.attentions, ...query.data } });
  });

  app.get("/api/cases/:caseId/effects", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!actor)
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    if (actor.role !== "OFFICER")
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Officer access is required",
        retryable: false,
      });
    if (!caseId.success)
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    let response: Response;
    try {
      response = await fetchImpl(
        `${alertAtomUrl}/internal/effects/case/${caseId.data}`,
        {
          headers: { Authorization: `Bearer ${workerServiceToken}` },
        }
      );
    } catch {
      return error(c, 503, {
        code: "ALERT_ATOM_UNAVAILABLE",
        message: "Alert service is unavailable",
        retryable: true,
      });
    }
    const parsed = z
      .object({ effects: z.array(DerivedEffectSummarySchema) })
      .safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !parsed.success) {
      return error(c, 503, {
        code: "ALERT_ATOM_UNAVAILABLE",
        message: "Alert service is unavailable",
        retryable: true,
      });
    }
    return c.json({ data: { items: parsed.data.effects } });
  });

  async function repairEffect(
    c: Context<GatewayEnv>,
    action: "retry" | "waive"
  ) {
    const actor = resolveActor(c.get("jwtPayload"));
    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    const effectId = z.string().min(1).safeParse(c.req.param("effectId"));
    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key")
    );
    if (!actor)
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    if (actor.role !== "OFFICER")
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Officer access is required",
        retryable: false,
      });
    if (!caseId.success || !effectId.success || !idempotencyKey.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID, effect ID, and Idempotency-Key are required",
        retryable: false,
      });
    }
    const rawInput = await c.req.json().catch(() => undefined);
    let input;
    let canonical;
    if (action === "retry") {
      input = RetryEffectInputSchema.safeParse(rawInput);
      if (!input.success)
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Effect repair input is invalid",
          retryable: false,
          details: input.error.flatten(),
        });
      canonical = canonicalRetryEffectPayload(
        caseId.data,
        effectId.data,
        input.data
      );
    } else {
      input = WaiveEffectInputSchema.safeParse(rawInput);
      if (!input.success)
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Effect repair input is invalid",
          retryable: false,
          details: input.error.flatten(),
        });
      canonical = canonicalWaiveEffectPayload(
        caseId.data,
        effectId.data,
        input.data
      );
    }
    const operation = operationForCase(
      caseId.data,
      idempotencyKey.data,
      canonical
    );
    const startWorkflowOperation = new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: operation.workflowId,
        taskQueue: ORCHESTRATION_TASK_QUEUE,
        args: [{ caseId: caseId.data }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    );
    const update = workflowClient.executeUpdateWithStart(
      action === "retry" ? UPDATE_NAMES.retryEffect : UPDATE_NAMES.waiveEffect,
      {
        args: [
          {
            idempotencyKey: operation.idempotencyKey,
            payloadHash: operation.updateId.slice(
              operation.idempotencyKey.length + 1
            ),
            operationId: operation.updateId,
            actorId: actor.accountId,
            actorRole: "OFFICER",
            caseId: caseId.data,
            effectId: effectId.data,
            input: input.data,
          },
        ],
        updateId: operation.updateId,
        startWorkflowOperation,
      }
    );
    void update.catch(() => undefined);

    let result: EffectRepairResult;
    try {
      result = EffectRepairResultSchema.parse(
        await withTimeout(update, updateTimeoutMs)
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.message === "workflow update timed out"
      ) {
        c.header("Retry-After", "2");
        return error(c, 504, {
          code: "WORKFLOW_UPDATE_PENDING",
          message: "Effect repair is still being processed",
          retryable: true,
          operation,
        });
      }
      if (isTemporalUnavailable(caught)) {
        return error(c, 503, {
          code: "TEMPORAL_UNAVAILABLE",
          message: "Case workflow service is unavailable",
          retryable: true,
          operation,
        });
      }
      return error(c, 500, {
        code: "WORKFLOW_UPDATE_FAILED",
        message: "Effect repair could not be completed",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "SUCCESS")
      return c.json({ data: result.effect, operation });
    return error(
      c,
      result.kind === "EFFECT_NOT_FOUND" || result.kind === "CASE_MISMATCH"
        ? 404
        : 409,
      {
        code: result.kind,
        message: "Effect repair is not available",
        retryable: false,
        operation,
      }
    );
  }

  app.post("/api/cases/:caseId/effects/:effectId/retry", (c) =>
    repairEffect(c, "retry")
  );
  app.post("/api/cases/:caseId/effects/:effectId/waive", (c) =>
    repairEffect(c, "waive")
  );

  app.get("/api/cases/:caseId/proof-items", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    const contractorId = z.uuid().safeParse(actor?.contractorId);
    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "CONTRACTOR" || !contractorId.success) {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Contractor access is required",
        retryable: false,
      });
    }
    if (!caseId.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    }
    // 151-D Task 5 (carry-over): `found()` alone would collapse UNAVAILABLE
    // and ABSENT to the same `null` — exactly the 151-C conflation this
    // route missed the first time, turning an unreachable assignment atom
    // into a wrong 404 for a legitimately-assigned Contractor. UNAVAILABLE
    // defers with 503; ABSENT (and a mismatched Contractor) still 404s —
    // authorization fails closed either way, never grants on a down atom.
    const assignmentLookup = await lookupCaseAssignment(
      assignmentAtomUrl,
      fetchImpl,
      caseId.data
    );
    if (assignmentLookup.status === "UNAVAILABLE") {
      return error(c, 503, {
        code: "ASSIGNMENT_ATOM_UNAVAILABLE",
        message: "Assignment service is unavailable",
        retryable: true,
      });
    }
    const assignment = found(assignmentLookup);
    if (assignment?.currentAttempt?.contractorId !== contractorId.data) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${proofAtomUrl}/internal/proof-items/${caseId.data}?${new URLSearchParams({ contractorId: contractorId.data })}`,
        { headers: { Authorization: `Bearer ${workerServiceToken}` } }
      );
    } catch {
      return error(c, 503, {
        code: "PROOF_ATOM_UNAVAILABLE",
        message: "Proof service is unavailable",
        retryable: true,
      });
    }
    if (!response.ok) {
      return error(c, 503, {
        code: "PROOF_ATOM_UNAVAILABLE",
        message: "Proof service is unavailable",
        retryable: true,
      });
    }
    const body = proofAtomListResponseSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!body.success) {
      return error(c, 503, {
        code: "PROOF_ATOM_UNAVAILABLE",
        message: "Proof service returned an invalid response",
        retryable: true,
      });
    }
    return c.json({ data: body.data.proof });
  });

  app.post(
    "/api/cases/:caseId/proof-items",
    bodyLimit({
      maxSize: MAX_PROOF_BODY_BYTES,
      onError: (c) =>
        error(c, 413, {
          code: "PROOF_FILE_TOO_LARGE",
          message: "Proof uploads must be 10 MiB or smaller",
          retryable: false,
        }),
    }),
    async (c) => {
      const actor = resolveActor(c.get("jwtPayload"));
      const contractorId = z.uuid().safeParse(actor?.contractorId);
      const caseId = z.uuid().safeParse(c.req.param("caseId"));
      const idempotencyKey = idempotencyKeySchema.safeParse(
        c.req.header("Idempotency-Key")
      );
      if (!actor) {
        return error(c, 401, {
          code: "INVALID_TOKEN",
          message: "Token subject is invalid",
          retryable: false,
        });
      }
      if (actor.role !== "CONTRACTOR" || !contractorId.success) {
        return error(c, 403, {
          code: "FORBIDDEN",
          message: "Contractor access is required",
          retryable: false,
        });
      }
      if (!caseId.success || !idempotencyKey.success) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Case ID and Idempotency-Key must be UUIDs",
          retryable: false,
        });
      }
      const form = await c.req.formData().catch(() => undefined);
      const file = form?.get("file");
      const type = z.enum(["BEFORE", "AFTER"]).safeParse(form?.get("type"));
      if (
        !form ||
        !(file instanceof File) ||
        !type.success ||
        [...form.keys()].some((key) => key !== "file" && key !== "type")
      ) {
        return error(c, 400, {
          code: "VALIDATION_ERROR",
          message: "Proof upload requires only a file and BEFORE or AFTER type",
          retryable: false,
        });
      }
      if (file.size > MAX_PROOF_FILE_BYTES) {
        return error(c, 413, {
          code: "PROOF_FILE_TOO_LARGE",
          message: "Proof uploads must be 10 MiB or smaller",
          retryable: false,
        });
      }
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (!isSupportedProofImage(file, header)) {
        return error(c, 415, {
          code: "UNSUPPORTED_PROOF_IMAGE",
          message: "Proof uploads must be JPEG, PNG, or WebP images",
          retryable: false,
        });
      }
      const [assignmentLookup, caseResponse] = await Promise.all([
        lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data),
        fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`).catch(
          () => undefined
        ),
      ]);
      const assignment = found(assignmentLookup);
      if (!caseResponse || !caseResponse.ok) {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service is unavailable",
          retryable: true,
        });
      }
      const parsedCase = caseAtomResponseSchema.safeParse(
        await caseResponse.json().catch(() => undefined)
      );
      if (!parsedCase.success || parsedCase.data.cases.length === 0) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
      const caseDto = toCaseDto(parsedCase.data.cases[0]);
      const appointment = found(
        await lookupAppointment(
          appointmentAtomUrl,
          fetchImpl,
          caseId.data,
          assignment?.currentAttempt?.id
        )
      );
      if (
        !assignment ||
        assignment.currentAttempt?.contractorId !== contractorId.data ||
        !appointment ||
        appointment.contractorId !== contractorId.data ||
        appointment.assignmentId !== assignment.assignment.id
      ) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
      if (
        caseDto.status !== "IN_PROGRESS" ||
        appointment.status !== "IN_PROGRESS"
      ) {
        return error(c, 409, {
          code: "NOT_IN_PROGRESS",
          message:
            "Case and Appointment must both be in progress to upload proof",
          retryable: false,
        });
      }
      const operation = operationForCase(
        caseId.data,
        idempotencyKey.data,
        JSON.stringify({ caseId: caseId.data, type: type.data })
      );
      const proofForm = new FormData();
      proofForm.append("file", file);
      proofForm.append("proofItemId", idempotencyKey.data);
      proofForm.append("caseId", caseId.data);
      proofForm.append("contractorId", contractorId.data);
      proofForm.append("type", type.data);

      let response: Response;
      try {
        response = await fetchImpl(`${proofAtomUrl}/internal/proof-items`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${workerServiceToken}`,
            "Idempotency-Key": idempotencyKey.data,
          },
          body: proofForm,
        });
      } catch {
        return error(c, 503, {
          code: "PROOF_ATOM_UNAVAILABLE",
          message: "Proof service is unavailable",
          retryable: true,
          operation,
        });
      }
      if (response.ok) {
        const body = proofAtomResponseSchema.safeParse(await response.json());
        if (body.success)
          return c.json({ data: body.data.proof, operation }, 201);
      }
      const upstream = z
        .object({ error: z.object({ code: z.string() }).optional() })
        .safeParse(await response.json().catch(() => undefined));
      const code = upstream.success ? upstream.data.error?.code : undefined;
      if (
        code === "IDEMPOTENCY_KEY_REUSED" ||
        code === "PROOF_CONTENT_MISMATCH"
      ) {
        return error(c, 409, {
          code,
          message: "Proof upload conflicts with the existing immutable item",
          retryable: false,
          operation,
        });
      }
      return error(c, 503, {
        code: "PROOF_ATOM_UNAVAILABLE",
        message: "Proof service is unavailable",
        retryable: true,
        operation,
      });
    }
  );

  app.put("/api/cases/:caseId/completion", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    const contractorId = z.uuid().safeParse(actor?.contractorId);
    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    const idempotencyKey = idempotencyKeySchema.safeParse(
      c.req.header("Idempotency-Key")
    );
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (actor.role !== "CONTRACTOR" || !contractorId.success) {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Contractor access is required",
        retryable: false,
      });
    }
    if (!caseId.success || !idempotencyKey.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID and Idempotency-Key must be UUIDs",
        retryable: false,
      });
    }
    const input = CompletionInputSchema.safeParse(
      await c.req.json().catch(() => undefined)
    );
    if (!input.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Completion report and proof selection are invalid",
        retryable: false,
        details: input.error.flatten(),
      });
    }
    const [assignmentLookup, caseResponse] = await Promise.all([
      lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data),
      fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`).catch(
        () => undefined
      ),
    ]);
    const assignment = found(assignmentLookup);
    if (!caseResponse || !caseResponse.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const parsedCase = caseAtomResponseSchema.safeParse(
      await caseResponse.json().catch(() => undefined)
    );
    if (!parsedCase.success || parsedCase.data.cases.length === 0) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    const caseDto = toCaseDto(parsedCase.data.cases[0]);
    const appointment = found(
      await lookupAppointment(
        appointmentAtomUrl,
        fetchImpl,
        caseId.data,
        assignment?.currentAttempt?.id
      )
    );
    if (
      !assignment ||
      assignment.currentAttempt?.contractorId !== contractorId.data ||
      !appointment ||
      appointment.contractorId !== contractorId.data
    ) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    if (
      (caseDto.status !== "IN_PROGRESS" && caseDto.status !== "COMPLETED") ||
      (appointment.status !== "IN_PROGRESS" &&
        appointment.status !== "COMPLETED")
    ) {
      return error(c, 409, {
        code: "NOT_IN_PROGRESS",
        message: "Case and Appointment must both be in progress",
        retryable: false,
      });
    }
    const operation = operationForCase(
      caseId.data,
      idempotencyKey.data,
      canonicalCompletionPayload(caseId.data, input.data)
    );
    const startWorkflowOperation = new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId: operation.workflowId,
        taskQueue: ORCHESTRATION_TASK_QUEUE,
        args: [{ caseId: caseId.data }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    );
    const update = workflowClient.executeUpdateWithStart(
      UPDATE_NAMES.completeCase,
      {
        args: [
          {
            idempotencyKey: operation.idempotencyKey,
            payloadHash: operation.updateId.slice(
              operation.idempotencyKey.length + 1
            ),
            operationId: operation.updateId,
            actorId: actor.accountId,
            actorRole: "CONTRACTOR",
            contractorId: contractorId.data,
            caseId: caseId.data,
            assignmentId: assignment.assignment.id,
            appointmentId: appointment.id,
            input: input.data,
          },
        ],
        updateId: `${operation.updateId}/delivery/${crypto.randomUUID()}`,
        startWorkflowOperation,
      }
    );
    void update.catch(() => undefined);
    let result: CompleteCaseResult;
    try {
      result = CompleteCaseResultSchema.parse(
        await withTimeout(update, updateTimeoutMs)
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.message === "workflow update timed out"
      ) {
        c.header("Retry-After", "2");
        return error(c, 504, {
          code: "WORKFLOW_UPDATE_PENDING",
          message: "Completion is still being processed",
          retryable: true,
          operation,
        });
      }
      if (isTemporalUnavailable(caught)) {
        return error(c, 503, {
          code: "TEMPORAL_UNAVAILABLE",
          message: "Case workflow service is unavailable",
          retryable: true,
          operation,
        });
      }
      return error(c, 500, {
        code: "WORKFLOW_UPDATE_FAILED",
        message: "Completion could not be completed",
        retryable: false,
        operation,
      });
    }
    if (result.kind === "SUCCESS")
      return c.json({ data: result.data, operation }, 200);
    if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
      return error(c, 409, {
        code: result.kind,
        message: "Idempotency-Key was already used with a different request",
        retryable: false,
        operation,
      });
    }
    if (
      result.kind === "CASE_MISMATCH" ||
      result.kind === "APPOINTMENT_MISMATCH"
    ) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
        operation,
      });
    }
    return error(c, 409, {
      code: result.kind,
      message: "Case completion is not available",
      retryable: false,
      operation,
    });
  });

  // A GET on the exact "/api/cases" path never matches the "/api/cases/:caseId"
  // route below it (different segment count) or the POST above (different
  // method) — Hono routes on method + segment shape, not registration order.
  app.get("/api/cases", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }

    const query = z
      .object({
        status: CaseStatusSchema.optional(),
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(100).default(25),
      })
      .safeParse(c.req.query());
    if (!query.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case list pagination is invalid",
        retryable: false,
        details: query.error.flatten(),
      });
    }

    if (actor.role === "RESIDENT" || actor.role === "OFFICER") {
      const params = new URLSearchParams({
        page: String(query.data.page),
        pageSize: String(query.data.pageSize),
      });
      // RESIDENT scopes to their own Cases; OFFICER sees every Case, with an
      // optional status filter. The atom's status column is lowercase.
      if (actor.role === "RESIDENT") {
        params.set("residentId", actor.accountId);
      }
      if (actor.role === "OFFICER" && query.data.status) {
        params.set("status", query.data.status.toLowerCase());
      }

      let response: Response;
      try {
        response = await fetchImpl(`${caseAtomUrl}/api/cases?${params}`);
      } catch {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service is unavailable",
          retryable: true,
        });
      }
      if (!response.ok) {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service is unavailable",
          retryable: true,
        });
      }
      const parsed = caseAtomResponseSchema.safeParse(
        await response.json().catch(() => undefined)
      );
      if (!parsed.success) {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service returned an invalid response",
          retryable: true,
        });
      }
      let items = parsed.data.cases.map(toCaseDto);
      // The `residentId` query param above is a filter, not an authorization
      // boundary — the Gateway re-verifies ownership itself rather than
      // trusting the atom, the same rule every other Resident-scoped read in
      // this file follows (e.g. the Case detail route below). A list surface
      // silently drops a mismatched row rather than 404ing: there is no
      // single resource here whose existence a 404 would confirm.
      if (actor.role === "RESIDENT") {
        items = items.filter((item) => item.residentId === actor.accountId);
      }
      return c.json({
        data: { items, page: query.data.page, pageSize: query.data.pageSize },
      });
    }

    // CONTRACTOR falls through to here unconditionally: AccountRoleSchema is
    // an exhaustive 3-value enum and resolveActor() already 401s any token
    // whose role does not parse against it, so there is no fourth role left
    // for an explicit gate to catch — the sibling routes' three-way checks
    // are a redundant belt-and-braces the type system already guarantees.
    //
    // The assignment atom's Contractor Case scope is the authoritative — and
    // paginated — source. The Case atom's `?ids=` call is a secondary fan-in
    // on top of it, never the source of scoping.
    const contractorId = z.uuid().safeParse(actor.contractorId);
    if (!contractorId.success) {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Contractor access is required",
        retryable: false,
      });
    }

    let scopeResponse: Response;
    try {
      scopeResponse = await fetchImpl(
        `${assignmentAtomUrl}/api/assignments/contractor/${contractorId.data}/cases?${new URLSearchParams(
          {
            page: String(query.data.page),
            pageSize: String(query.data.pageSize),
          }
        )}`
      );
    } catch {
      return error(c, 503, {
        code: "ASSIGNMENT_ATOM_UNAVAILABLE",
        message: "Assignment service is unavailable",
        retryable: true,
      });
    }
    if (!scopeResponse.ok) {
      return error(c, 503, {
        code: "ASSIGNMENT_ATOM_UNAVAILABLE",
        message: "Assignment service is unavailable",
        retryable: true,
      });
    }
    const scopeParsed = contractorCaseScopeResponseSchema.safeParse(
      await scopeResponse.json().catch(() => undefined)
    );
    if (!scopeParsed.success) {
      return error(c, 503, {
        code: "ASSIGNMENT_ATOM_UNAVAILABLE",
        message: "Assignment service returned an invalid response",
        retryable: true,
      });
    }

    if (scopeParsed.data.items.length === 0) {
      return c.json({
        data: {
          items: [],
          page: query.data.page,
          pageSize: query.data.pageSize,
        },
      });
    }

    let casesResponse: Response;
    try {
      // At most `pageSize` (capped at 100 by the query schema above) ids go
      // on this query string — 100 UUIDs is ~3.7KB, safely under Node's
      // default 16KB header limit. Raising that cap later must keep this in
      // mind, or a large scope page turns into a request-line failure.
      casesResponse = await fetchImpl(
        `${caseAtomUrl}/api/cases?${new URLSearchParams({
          ids: scopeParsed.data.items.map((item) => item.caseId).join(","),
          // The case atom skips the offset when `ids` is present but still
          // applies `.limit(pageSize)` — forwarding anything smaller than the
          // scope page's own pageSize would silently truncate the response.
          pageSize: String(query.data.pageSize),
        })}`
      );
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!casesResponse.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const casesParsed = caseAtomResponseSchema.safeParse(
      await casesResponse.json().catch(() => undefined)
    );
    if (!casesParsed.success) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service returned an invalid response",
        retryable: true,
      });
    }

    const casesById = new Map(
      casesParsed.data.cases.map((record) => {
        const caseDto = toCaseDto(record);
        return [caseDto.id, caseDto] as const;
      })
    );

    // The scope route's order (newest Attempt first) is authoritative; the
    // `?ids=` response comes back ordered by the Case atom's own createdAt,
    // so items are re-collected in scope order rather than passed through.
    const items = scopeParsed.data.items.flatMap((scopeItem) => {
      const caseDto = casesById.get(scopeItem.caseId);
      if (!caseDto) return [];
      return [
        scopeItem.participation === "CURRENT"
          ? caseDto
          : HistoricalContractorCaseDtoSchema.parse({
              ...caseDto,
              postalSector: postalSector(caseDto.postalCode),
            }),
      ];
    });

    return c.json({
      data: { items, page: query.data.page, pageSize: query.data.pageSize },
    });
  });

  app.get("/api/cases/:caseId", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }
    if (
      actor.role !== "RESIDENT" &&
      actor.role !== "OFFICER" &&
      actor.role !== "CONTRACTOR"
    ) {
      return error(c, 403, {
        code: "FORBIDDEN",
        message: "Resident, Officer, or Contractor access is required",
        retryable: false,
      });
    }

    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!caseId.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    }

    // 151-D Task 2 — a redaction boundary, not a plumbing detail: the case
    // atom's public route runs `publicCase()`, which strips
    // completionOperationId/completionReport/completionProofItemIds for
    // every reader. An Officer reviewing a COMPLETED Case needs those, so
    // the Officer alone reads the internal, un-redacted route (service
    // token) — Resident and Contractor stay on the public route below and
    // must never see completion internals.
    if (actor.role === "OFFICER") {
      let officerResponse: Response;
      try {
        officerResponse = await fetchImpl(
          `${caseAtomUrl}/internal/cases/${caseId.data}`,
          { headers: { Authorization: `Bearer ${workerServiceToken}` } }
        );
      } catch {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service is unavailable",
          retryable: true,
        });
      }
      if (officerResponse.status === 404) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
      if (!officerResponse.ok) {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service is unavailable",
          retryable: true,
        });
      }
      const parsedOfficerCase = internalCaseAtomResponseSchema.safeParse(
        await officerResponse.json().catch(() => undefined)
      );
      if (!parsedOfficerCase.success || !parsedOfficerCase.data.case) {
        return error(c, 503, {
          code: "CASE_ATOM_UNAVAILABLE",
          message: "Case service returned an invalid response",
          retryable: true,
        });
      }
      const officerCaseDto = toOfficerCaseDto(parsedOfficerCase.data.case);

      // 151-D Task 1 — full state: the existing current-Attempt/Appointment
      // envelope stays (existing behaviour, `found()` — informational for
      // an Officer, since access was already settled above and nothing here
      // gates authorization), and the four full-history sections are added
      // alongside it via the same per-source fetchers the timeline uses.
      // An UNAVAILABLE source degrades to `[]` for the same reason: purely
      // additive display data, not an authorization check.
      const [
        caseAssignmentLookup,
        attemptsLookup,
        appointmentSource,
        proofItemSource,
        derivedEffectSource,
        officerAttentionSource,
      ] = await Promise.all([
        lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data),
        lookupAttemptHistory(assignmentAtomUrl, fetchImpl, caseId.data),
        fetchAppointmentSource(appointmentAtomUrl, fetchImpl, caseId.data),
        fetchProofItemSource(
          proofAtomUrl,
          fetchImpl,
          workerServiceToken,
          caseId.data
        ),
        fetchDerivedEffectSource(
          alertAtomUrl,
          fetchImpl,
          workerServiceToken,
          caseId.data
        ),
        fetchOfficerAttentionSource(caseAtomUrl, fetchImpl, caseId.data),
      ]);
      const caseAssignment = found(caseAssignmentLookup);
      const appointment = found(
        await lookupAppointment(
          appointmentAtomUrl,
          fetchImpl,
          caseId.data,
          caseAssignment?.currentAttempt?.id
        )
      );

      return c.json({
        data: {
          ...officerCaseDto,
          assignment: caseAssignment
            ? {
                ...caseAssignment.assignment,
                currentAttempt: caseAssignment.currentAttempt,
                appointment,
              }
            : null,
          attempts:
            attemptsLookup.status === "FOUND"
              ? caseDetailSection(
                  attemptsLookup.data.map(allocationAttemptEvent),
                  actor,
                  null,
                  AllocationAttemptDtoSchema
                )
              : [],
          appointments:
            appointmentSource.status === "FOUND"
              ? caseDetailSection(
                  appointmentSource.events,
                  actor,
                  null,
                  AppointmentDtoSchema
                )
              : [],
          proofItems:
            proofItemSource.status === "FOUND"
              ? caseDetailSection(
                  proofItemSource.events,
                  actor,
                  null,
                  ProofItemDtoSchema
                )
              : [],
          effects:
            derivedEffectSource.status === "FOUND"
              ? caseDetailSection(
                  derivedEffectSource.events,
                  actor,
                  null,
                  DerivedEffectSummarySchema
                )
              : [],
          officerAttention:
            officerAttentionSource.status === "FOUND"
              ? caseDetailSection(
                  officerAttentionSource.events,
                  actor,
                  null,
                  OfficerAttentionDtoSchema
                )
              : [],
        },
      });
    }

    // RESIDENT and CONTRACTOR: the public route, `publicCase()`-redacted.
    let response: Response;
    try {
      response = await fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`);
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!response.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }

    const parsed = caseAtomResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.cases.length === 0) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }

    const caseDto = toCaseDto(parsed.data.cases[0]);

    if (actor.role === "RESIDENT") {
      if (caseDto.residentId !== actor.accountId) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
      const caseAssignment = found(
        await lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data)
      );
      const appointment = found(
        await lookupAppointment(
          appointmentAtomUrl,
          fetchImpl,
          caseId.data,
          caseAssignment?.currentAttempt?.id
        )
      );
      // A Resident gets the Appointment flat and narrowed — they need its id
      // and interval to Reschedule it (PRS-146), and nothing else the
      // Assignment envelope carries: not its id, not an Attempt they may
      // never see. The Reschedule route narrows its success body the same
      // way, so neither hands back what the other strips.
      return c.json({
        data: {
          ...caseDto,
          appointment: toResidentAppointmentDto(appointment),
        },
      });
    }

    // CONTRACTOR: current vs historical (151-D Task 3), reusing the exact
    // participation derivation the timeline route already uses (AC7 before
    // AC8 — the Attempt history is authorization here, checked before any
    // other secondary source is touched) rather than a second copy of it.
    const attemptsLookup = await lookupAttemptHistory(
      assignmentAtomUrl,
      fetchImpl,
      caseId.data
    );
    if (attemptsLookup.status === "UNAVAILABLE") {
      // Never grants on an unreachable atom (AC7 fails closed) — but 404ing
      // it would tell a legitimately-assigned Contractor their own Case
      // does not exist. 503 defers the read instead of answering it wrong.
      return error(c, 503, {
        code: "ASSIGNMENT_ATOM_UNAVAILABLE",
        message: "Assignment service is unavailable",
        retryable: true,
      });
    }
    const everHeldCase = attemptsLookup.data.some(
      (attempt) => attempt.contractorId === actor.contractorId
    );
    if (!actor.contractorId || !everHeldCase) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    const newestContractorAttempt = newestAttempt(attemptsLookup.data);
    const participation: "CURRENT" | "HISTORICAL" =
      newestContractorAttempt !== undefined &&
      newestContractorAttempt.contractorId === actor.contractorId &&
      (newestContractorAttempt.status === "PENDING_ACCEPTANCE" ||
        newestContractorAttempt.status === "ACCEPTED")
        ? "CURRENT"
        : "HISTORICAL";

    // Only now, after authorization, do the remaining sources fan out —
    // each an existing per-source timeline fetcher, filtered through the
    // same `includeTimelineEventForRole` participation rule (Task 3: no
    // third copy of the CURRENT/HISTORICAL rule). Row filtering, not field
    // dropping — a replacement Contractor's rows are excluded wholesale,
    // never partially redacted, so no replacement id can survive nested
    // inside a surviving row's `detail` or `operationId`.
    const [
      appointmentSource,
      proofItemSource,
      derivedEffectSource,
      caseAssignmentLookup,
    ] = await Promise.all([
      fetchAppointmentSource(appointmentAtomUrl, fetchImpl, caseId.data),
      fetchProofItemSource(
        proofAtomUrl,
        fetchImpl,
        workerServiceToken,
        caseId.data
      ),
      fetchDerivedEffectSource(
        alertAtomUrl,
        fetchImpl,
        workerServiceToken,
        caseId.data
      ),
      lookupCaseAssignment(assignmentAtomUrl, fetchImpl, caseId.data),
    ]);

    // The `assignment` envelope is a CURRENT Contractor's own live work —
    // their Attempt, their Appointment — and is what every action control in
    // `contractor/.../case-audit-trail.tsx` derives from (Accept, Start Work,
    // No Access, Complete). A HISTORICAL Contractor gets `null` instead:
    // there `currentAttempt` belongs to the *replacement*, so returning it
    // would leak exactly what AC6 forbids. The narrowing is scoped to the
    // participation that actually leaks, not applied to both.
    const contractorAssignment =
      participation === "CURRENT" && caseAssignmentLookup.status === "FOUND"
        ? {
            ...caseAssignmentLookup.data.assignment,
            currentAttempt: caseAssignmentLookup.data.currentAttempt,
            appointment: found(
              await lookupAppointment(
                appointmentAtomUrl,
                fetchImpl,
                caseId.data,
                caseAssignmentLookup.data.currentAttempt?.id
              )
            ),
          }
        : null;

    // A HISTORICAL Contractor's Case fields are narrowed the same way the
    // Contractor Case list already narrows them (151-B): Resident identity
    // and full address dropped, `postalSector` in their place. No
    // `officerAttention` section for either participation — internal
    // attention is never a Contractor's to see (AC5/AC6).
    const contractorCaseDto =
      participation === "CURRENT"
        ? caseDto
        : HistoricalContractorCaseDtoSchema.parse({
            ...caseDto,
            postalSector: postalSector(caseDto.postalCode),
          });

    return c.json({
      data: {
        ...contractorCaseDto,
        assignment: contractorAssignment,
        attempts: caseDetailSection(
          attemptsLookup.data.map(allocationAttemptEvent),
          actor,
          participation,
          AllocationAttemptDtoSchema
        ),
        appointments:
          appointmentSource.status === "FOUND"
            ? caseDetailSection(
                appointmentSource.events,
                actor,
                participation,
                AppointmentDtoSchema
              )
            : [],
        proofItems:
          proofItemSource.status === "FOUND"
            ? caseDetailSection(
                proofItemSource.events,
                actor,
                participation,
                ProofItemDtoSchema
              )
            : [],
        effects:
          derivedEffectSource.status === "FOUND"
            ? caseDetailSection(
                derivedEffectSource.events,
                actor,
                participation,
                DerivedEffectSummarySchema
              )
            : [],
      },
    });
  });

  app.get("/api/cases/:caseId/timeline", async (c) => {
    const actor = resolveActor(c.get("jwtPayload"));
    if (!actor) {
      return error(c, 401, {
        code: "INVALID_TOKEN",
        message: "Token subject is invalid",
        retryable: false,
      });
    }

    const caseId = z.uuid().safeParse(c.req.param("caseId"));
    if (!caseId.success) {
      return error(c, 400, {
        code: "VALIDATION_ERROR",
        message: "Case ID must be a UUID",
        retryable: false,
      });
    }

    // AC7 before AC8, step 1: the Case atom primary lookup.
    let caseResponse: Response;
    try {
      caseResponse = await fetchImpl(`${caseAtomUrl}/api/cases/${caseId.data}`);
    } catch {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    if (!caseResponse.ok) {
      return error(c, 503, {
        code: "CASE_ATOM_UNAVAILABLE",
        message: "Case service is unavailable",
        retryable: true,
      });
    }
    const parsedCase = caseAtomResponseSchema.safeParse(
      await caseResponse.json().catch(() => undefined)
    );
    if (!parsedCase.success || parsedCase.data.cases.length === 0) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }
    const caseDto = toCaseDto(parsedCase.data.cases[0]);

    // AC7 before AC8, step 2: ownership/participation authorization — strictly
    // before any secondary source is touched, so a partial fan-out can never
    // leak whether an unauthorized actor's Case even exists.
    if (actor.role === "RESIDENT" && caseDto.residentId !== actor.accountId) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }

    let participation: "CURRENT" | "HISTORICAL" | null = null;
    // Set only for a Contractor, and reused in the fan-out below — the
    // Attempt history is fetched exactly once even though it is both the
    // authorization source and the ALLOCATION_ATTEMPT timeline source.
    let contractorAttempts: AllocationAttemptDto[] | undefined;

    if (actor.role === "CONTRACTOR") {
      // Unlike every other route, the Attempt history is a PRIMARY source
      // here — it is the only way to know whether this Contractor ever held
      // the Case. An unreachable assignment atom cannot fall back to "not
      // authorized" (that would let a transient outage hide a Contractor's
      // own Case forever); it defers with 503 instead, never granting.
      // For OFFICER (no branch needed below — AccountRoleSchema is an
      // exhaustive 3-value enum and resolveActor() already 401s anything
      // else) and RESIDENT above, the identical call is only a secondary
      // timeline source, and an UNAVAILABLE there just joins
      // `missingSources`.
      const attemptsLookup = await lookupAttemptHistory(
        assignmentAtomUrl,
        fetchImpl,
        caseId.data
      );
      if (attemptsLookup.status === "UNAVAILABLE") {
        return error(c, 503, {
          code: "ASSIGNMENT_ATOM_UNAVAILABLE",
          message: "Assignment service is unavailable",
          retryable: true,
        });
      }
      contractorAttempts = attemptsLookup.data;
      const everHeldCase = contractorAttempts.some(
        (attempt) => attempt.contractorId === actor.contractorId
      );
      if (!actor.contractorId || !everHeldCase) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
      const newest = newestAttempt(contractorAttempts);
      participation =
        newest !== undefined &&
        newest.contractorId === actor.contractorId &&
        (newest.status === "PENDING_ACCEPTANCE" || newest.status === "ACCEPTED")
          ? "CURRENT"
          : "HISTORICAL";
    }

    // AC7 before AC8, step 3: only now, after authorization, does the
    // remaining fan-out run — every source resolves independently and an
    // UNAVAILABLE one degrades to `missingSources` rather than the request
    // outcome.
    const allocationAttemptSourcePromise: Promise<TimelineSourceLookup> =
      contractorAttempts
        ? Promise.resolve({
            status: "FOUND",
            events: contractorAttempts.map(allocationAttemptEvent),
          })
        : lookupAttemptHistory(assignmentAtomUrl, fetchImpl, caseId.data).then(
            (lookup): TimelineSourceLookup =>
              lookup.status === "FOUND"
                ? {
                    status: "FOUND",
                    events: lookup.data.map(allocationAttemptEvent),
                  }
                : { status: "UNAVAILABLE" }
          );

    const [
      caseHistorySource,
      allocationAttemptSource,
      assignmentStatusSource,
      appointmentSource,
      proofItemSource,
      derivedEffectSource,
      officerAttentionSource,
    ] = await Promise.all([
      fetchCaseHistorySource(caseAtomUrl, fetchImpl, caseId.data),
      allocationAttemptSourcePromise,
      fetchAssignmentStatusSource(assignmentAtomUrl, fetchImpl, caseId.data),
      fetchAppointmentSource(appointmentAtomUrl, fetchImpl, caseId.data),
      fetchProofItemSource(
        proofAtomUrl,
        fetchImpl,
        workerServiceToken,
        caseId.data
      ),
      fetchDerivedEffectSource(
        alertAtomUrl,
        fetchImpl,
        workerServiceToken,
        caseId.data
      ),
      fetchOfficerAttentionSource(caseAtomUrl, fetchImpl, caseId.data),
    ]);

    const sources: Array<[TimelineEventSource, TimelineSourceLookup]> = [
      ["CASE_HISTORY", caseHistorySource],
      ["ALLOCATION_ATTEMPT", allocationAttemptSource],
      ["ASSIGNMENT_STATUS", assignmentStatusSource],
      ["APPOINTMENT", appointmentSource],
      ["PROOF_ITEM", proofItemSource],
      ["DERIVED_EFFECT", derivedEffectSource],
      ["OFFICER_ATTENTION", officerAttentionSource],
    ];

    // `missingSources` reports atom reachability, not row content — it is
    // built from the fixed seven-value `TimelineEventSource` enum before any
    // role/participation filtering runs below, and every role fetches the
    // same seven sources regardless of what it is later allowed to see. A
    // name landing here can never disclose a Case fact (a Contractor id, a
    // row count, anything derived from data) to a role that is not supposed
    // to see it — it is only ever one of these seven fixed literals.
    const missingSources: TimelineEventSource[] = [];
    const collected: TimelineEvent[] = [];
    for (const [name, outcome] of sources) {
      if (outcome.status === "UNAVAILABLE") {
        missingSources.push(name);
      } else {
        collected.push(...outcome.events);
      }
    }

    // Task 4's role filter runs after normalization, over the one shared
    // shape; a Resident's surviving rows are then narrowed by
    // `redactForResident` (reachability and content are separate decisions —
    // see the comment on each); then the deterministic sort; then
    // `contractorId` — internal-only, never in the contract DTO — is
    // stripped before the response leaves.
    const items: TimelineEventDto[] = collected
      .filter((event) =>
        includeTimelineEventForRole(event, actor, participation)
      )
      .map((event) =>
        actor.role === "RESIDENT" ? redactForResident(event) : event
      )
      .toSorted(compareTimelineEvents)
      .map(({ contractorId: _contractorId, ...event }) => event);

    return c.json({ data: { items, missingSources } });
  });

  return app;
}

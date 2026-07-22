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
  AllocationAttemptDtoSchema,
  AppointmentDtoSchema,
  AssignmentDtoSchema,
  CaseDtoSchema,
  canonicalManualAllocationPayload,
  canonicalAcceptAllocationPayload,
  canonicalOpenCasePayload,
  caseWorkflowId,
  MeDtoSchema,
  ManualAllocationInputSchema,
  ManualAllocationResultSchema,
  OfficerAttentionDtoSchema,
  OpenCaseInputSchema,
  OpenCaseResultSchema,
  OperationSchema,
  ORCHESTRATION_TASK_QUEUE,
  residentProvisioningWorkflowId,
  ResidentOpenCaseInputSchema,
  UPDATE_NAMES,
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
  ManualAllocationResult,
  OpenCaseInput,
  OpenCaseResult,
  Operation,
} from "@townops/orchestration-contract";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod/v4";

const idempotencyKeySchema = z.uuid();
const caseAtomResponseSchema = z.object({ cases: z.array(z.unknown()) });
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
const officerAttentionAtomResponseSchema = z.object({
  attentions: z.array(OfficerAttentionDtoSchema),
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

const browserOrigins = new Set([
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
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
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503 | 504,
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

type CaseAssignment = {
  assignment: AssignmentDto;
  currentAttempt: AllocationAttemptDto | null;
};

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

async function lookupAppointment(
  appointmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string,
  attemptId: string | undefined
) {
  if (!attemptId) return null;
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
        .find((appointment) => appointment?.attemptId === attemptId) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Looks up a Case's stable Assignment and current pending Attempt from the
 * assignment atom (AC7). A secondary source — an unreachable atom, an
 * unexpected response shape, or no Assignment yet — resolves to null rather
 * than failing the Case lookup closed.
 */
async function lookupCaseAssignment(
  assignmentAtomUrl: string,
  fetchImpl: typeof fetch,
  caseId: string
): Promise<CaseAssignment | null> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${assignmentAtomUrl}/api/assignments/by-case/${caseId}`
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const parsed = assignmentAtomResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success || !parsed.data.assignment) return null;

  const assignment = AssignmentDtoSchema.safeParse(parsed.data.assignment);
  if (!assignment.success) return null;

  let currentAttempt: AllocationAttemptDto | null = null;
  if (parsed.data.attempt) {
    const attempt = AllocationAttemptDtoSchema.safeParse(parsed.data.attempt);
    if (attempt.success) currentAttempt = attempt.data;
  }

  return { assignment: assignment.data, currentAttempt };
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

export function createGatewayApp({
  workflowClient,
  caseAtomUrl,
  residentAtomUrl,
  authAtomUrl,
  assignmentAtomUrl = "http://localhost:5004",
  appointmentAtomUrl = "http://localhost:5003",
  authenticate,
  fetchImpl = fetch,
  updateTimeoutMs = 20_000,
}: GatewayDependencies) {
  const app = new Hono<GatewayEnv>();

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
    for (const name of ["content-type", "authorization", "cookie"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }

    const method = c.req.method;
    const body =
      method === "GET" || method === "HEAD" ? undefined : await c.req.text();

    let upstream: Response;
    try {
      upstream = await fetchImpl(target, { method, headers, body });
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
      const caseAssignment = await lookupCaseAssignment(
        assignmentAtomUrl,
        fetchImpl,
        caseId.data
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

    let response: Response;
    try {
      response = await fetchImpl(
        `${caseAtomUrl}/api/cases/officer-attention?${new URLSearchParams({
          state: query.data.state,
          page: String(query.data.page),
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
    if (actor.role === "RESIDENT" && caseDto.residentId !== actor.accountId) {
      return error(c, 404, {
        code: "CASE_NOT_FOUND",
        message: "Case was not found",
        retryable: false,
      });
    }

    // A Resident sees their Case as before — no contractor scores or
    // internal attention attached.
    if (actor.role === "RESIDENT") {
      return c.json({ data: caseDto });
    }

    const caseAssignment = await lookupCaseAssignment(
      assignmentAtomUrl,
      fetchImpl,
      caseId.data
    );

    if (actor.role === "CONTRACTOR") {
      const isNamedOnCurrentAttempt =
        caseAssignment?.currentAttempt?.contractorId === actor.contractorId;
      if (!actor.contractorId || !isNamedOnCurrentAttempt) {
        return error(c, 404, {
          code: "CASE_NOT_FOUND",
          message: "Case was not found",
          retryable: false,
        });
      }
    }

    const appointment = await lookupAppointment(
      appointmentAtomUrl,
      fetchImpl,
      caseId.data,
      caseAssignment?.currentAttempt?.id
    );

    return c.json({
      data: {
        ...caseDto,
        assignment: caseAssignment
          ? {
              ...caseAssignment.assignment,
              currentAttempt: caseAssignment.currentAttempt,
              appointment,
            }
          : null,
      },
    });
  });

  return app;
}

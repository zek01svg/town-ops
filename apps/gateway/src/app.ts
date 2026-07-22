import { createHash } from "node:crypto";

import {
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
import {
  AccountRoleSchema,
  AllocationAttemptDtoSchema,
  AssignmentDtoSchema,
  CaseDtoSchema,
  canonicalOpenCasePayload,
  caseWorkflowId,
  MeDtoSchema,
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
  AllocationAttemptDto,
  ApiError,
  AssignmentDto,
  CaseDto,
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
const authResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
  }),
});
const browserOrigins = new Set([
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
]);

type GatewayWorkflowClient = {
  executeUpdateWithStart(updateName: string, options: any): Promise<unknown>;
  start(workflowType: string, options: any): Promise<unknown>;
};

type GatewayDependencies = {
  workflowClient: GatewayWorkflowClient;
  caseAtomUrl: string;
  residentAtomUrl: string;
  authAtomUrl: string;
  assignmentAtomUrl?: string;
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
  const payloadHash = createHash("sha256")
    .update(canonicalPayload)
    .digest("hex");
  const caseId = deterministicUuid(idempotencyKey);
  return OperationSchema.parse({
    caseId,
    workflowId: caseWorkflowId(caseId),
    updateId: `${idempotencyKey}.${payloadHash}`,
    idempotencyKey,
  });
}

function isTemporalUnavailable(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate?.code === 14 ||
    (typeof candidate?.message === "string" &&
      /unavailable|econnrefused/i.test(candidate.message))
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
  const source = record as Record<string, unknown>;
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
      allowMethods: ["GET", "POST", "OPTIONS"],
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

    return c.json({
      data: {
        ...caseDto,
        assignment: caseAssignment
          ? {
              ...caseAssignment.assignment,
              currentAttempt: caseAssignment.currentAttempt,
            }
          : null,
      },
    });
  });

  return app;
}

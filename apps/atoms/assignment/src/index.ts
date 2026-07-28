import { Scalar } from "@scalar/hono-api-reference";
import {
  CancelAssignmentInputSchema,
  AcceptAllocationAttemptInputSchema,
  BreachAllocationAttemptInputSchema,
  CompleteAssignmentInputSchema,
  CommitAllocationInputSchema,
  MarkAssignmentInProgressInputSchema,
} from "@townops/orchestration-contract";
import {
  logger,
  honoLogger,
  corsOrigins,
  initSentry,
  captureHonoException,
  workerAuth,
} from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import {
  assignmentsInsertSchema,
  assignmentsSelectSchema,
  assignmentStatusHistorySelectSchema,
} from "./database/schema";
import { env } from "./env";
import * as assignmentService from "./service";
import {
  getAssignmentByCaseSchema,
  getAssignmentByIdSchema,
  reassignAssignmentSchema,
  updateAssignmentStatusSchema,
} from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "assignment-atom" });

const SLA_REASSIGN_WINDOW_MS = 15 * 1000;

const devOrigins = corsOrigins();
if (devOrigins) {
  app.use(
    "*",
    cors({
      origin: devOrigins,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    })
  );
}

app.onError((err, c) => {
  captureHonoException(err, c);
  logger.error(
    {
      error: err.message,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : err.cause,
      route: c.req.path,
    },
    "[assignment atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

const assignmentsRouter = new Hono()
  .post(
    "/",
    describeRoute({
      description: "Create a new assignment record",
      responses: {
        201: {
          description: "Assignment created",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: assignmentsSelectSchema })
              ),
            },
          },
        },
      },
    }),
    validator("json", assignmentsInsertSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
      return undefined;
    }),
    async (c) => {
      const body = c.req.valid("json");
      const assignment = await assignmentService.createAssignment(body);

      logger.info(
        {
          route: "/api/assignments",
          assignmentId: assignment.id,
          caseId: body.caseId,
        },
        "Assignment created successfully"
      );

      return c.json({ assignments: assignment }, 201);
    }
  )
  .get(
    "/contractor/:contractor_id",
    describeRoute({
      description: "Get all assignments for a contractor",
      responses: {
        200: {
          description: "Assignments found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: z.array(assignmentsSelectSchema) })
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const { contractor_id } = c.req.param();
      const result =
        await assignmentService.getAssignmentsByContractorId(contractor_id);
      return c.json({ assignments: result }, 200);
    }
  )
  .get(
    "/by-case/:case_id",
    describeRoute({
      description:
        "Public read: the stable Assignment plus its current pending Attempt for a Case (PRS-139)",
      responses: {
        200: {
          description: "Assignment (and current Attempt, if any) for the Case",
        },
      },
    }),
    validator(
      "param",
      z.object({ case_id: getAssignmentByCaseSchema }),
      (result, c) => {
        if (!result.success) return c.json({ error: "Validation failed" }, 400);
        return undefined;
      }
    ),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const result =
        await assignmentService.getAssignmentWithCurrentAttempt(case_id);

      return c.json(
        {
          assignment: result?.assignment ?? null,
          attempt: result?.currentAttempt ?? null,
        },
        200
      );
    }
  )
  .get(
    "/:case_id",
    describeRoute({
      description: "Get assignment by case id",
      responses: {
        200: {
          description: "Assignment found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: assignmentsSelectSchema.optional() })
              ),
            },
          },
        },
      },
    }),
    validator(
      "param",
      z.object({ case_id: getAssignmentByCaseSchema }),
      (result, c) => {
        if (!result.success) return c.json({ error: "Validation failed" }, 400);
        return undefined;
      }
    ),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const assignment = await assignmentService.getAssignmentByCaseId(case_id);

      logger.info(
        {
          route: "/api/assignments/:case_id",
          caseId: case_id,
          found: !!assignment,
        },
        "Assignment lookup by case_id executed"
      );

      return c.json({ assignments: assignment }, 200);
    }
  )
  .get(
    "/:case_id/history",
    describeRoute({
      description: "Get assignment status history for a case",
      responses: {
        200: {
          description: "Status history",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  history: z.array(assignmentStatusHistorySelectSchema),
                })
              ),
            },
          },
        },
        404: { description: "No assignment found for case" },
      },
    }),
    validator(
      "param",
      z.object({ case_id: getAssignmentByCaseSchema }),
      (result, c) => {
        if (!result.success) return c.json({ error: "Validation failed" }, 400);
        return undefined;
      }
    ),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const assignment = await assignmentService.getAssignmentByCaseId(case_id);
      if (!assignment) return c.json({ history: [] }, 200);

      const history = await assignmentService.getStatusHistoryByAssignmentId(
        assignment.id
      );
      logger.info(
        { route: "/api/assignments/:case_id/history", caseId: case_id },
        "Status history fetched"
      );
      return c.json({ history }, 200);
    }
  )
  .put(
    "/:id/reassign",
    describeRoute({
      description:
        "Reassign an existing assignment to a new contractor and reset SLA",
      responses: {
        200: {
          description: "Assignment reassigned",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: assignmentsSelectSchema })
              ),
            },
          },
        },
        404: { description: "Assignment not found" },
      },
    }),
    validator(
      "param",
      z.object({ id: getAssignmentByIdSchema }),
      (result, c) => {
        if (!result.success) return c.json({ error: "Validation failed" }, 400);
        return undefined;
      }
    ),
    validator("json", reassignAssignmentSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
      return undefined;
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { contractorId, responseDueAt, changedBy, reason } =
        c.req.valid("json");

      const newResponseDueAt =
        responseDueAt ??
        new Date(Date.now() + SLA_REASSIGN_WINDOW_MS).toISOString();

      const result = await assignmentService.reassignAssignment(
        id,
        contractorId,
        newResponseDueAt,
        changedBy,
        reason ?? "SLA_BREACH"
      );

      if (!result) {
        return c.json({ error: "Assignment not found" }, 404);
      }

      logger.info(
        {
          route: "/api/assignments/:id/reassign",
          assignmentId: id,
          contractorId,
        },
        "Assignment reassigned"
      );

      return c.json({ assignments: result }, 200);
    }
  )
  .put(
    "/:id/status",
    describeRoute({
      description: "Update assignment status and record history",
      responses: {
        200: {
          description: "Status updated",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: assignmentsSelectSchema })
              ),
            },
          },
        },
        404: { description: "Assignment not found" },
      },
    }),
    validator(
      "param",
      z.object({ id: getAssignmentByIdSchema }),
      (result, c) => {
        if (!result.success) return c.json({ error: "Validation failed" }, 400);
        return undefined;
      }
    ),
    validator("json", updateAssignmentStatusSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
      return undefined;
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { status, changedBy, reason } = c.req.valid("json");

      const result = await assignmentService.updateAssignmentStatus(
        id,
        status,
        changedBy,
        reason
      );

      if (!result) {
        return c.json({ error: "Assignment not found" }, 404);
      }

      logger.info(
        {
          route: "/api/assignments/:id/status",
          assignmentId: id,
          newStatus: status,
        },
        "Assignment status updated and history recorded"
      );

      return c.json({ assignments: result }, 200);
    }
  );

// ─── /internal/assignments (Worker-only, PRS-139) ────────────────────────────

const internalAssignmentsRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/completion-operation/:assignmentId",
    describeRoute({ description: "Read an Assignment completion operation" }),
    validator("param", z.object({ assignmentId: z.uuid() })),
    async (c) => {
      const identity = await assignmentService.getAssignmentCompletionOperation(
        c.req.valid("param").assignmentId
      );
      if (!identity) {
        return c.json({ error: "Assignment not found" }, 404);
      }
      return c.json(identity, 200);
    }
  )
  .get(
    "/allocation-snapshot",
    describeRoute({
      description:
        "Global allocation epoch plus active Attempt counts per Contractor",
    }),
    async (c) => {
      const snapshot = await assignmentService.getAllocationSnapshot();
      return c.json(snapshot, 200);
    }
  )
  .post(
    "/allocation-attempts",
    describeRoute({
      description: "Commit one allocation Attempt for a Case",
    }),
    validator("json", CommitAllocationInputSchema),
    async (c) => {
      const body = c.req.valid("json");
      const result = await assignmentService.commitAllocationAttempt(body);

      if (
        result.outcome === "STALE_EPOCH" ||
        result.outcome === "ACTIVE_ATTEMPT_EXISTS" ||
        result.outcome === "OVERRIDE_REASON_REQUIRED"
      ) {
        return c.json(result, 409);
      }
      if (result.outcome === "ALREADY_COMMITTED") {
        return c.json(result, 200);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/allocation-attempts/breach",
    describeRoute({
      description: "Breach one Allocation Attempt (PRS-144)",
    }),
    validator("json", BreachAllocationAttemptInputSchema),
    async (c) => {
      const result = await assignmentService.breachAllocationAttempt(
        c.req.valid("json")
      );
      return c.json(result, result.outcome === "BREACHED" ? 201 : 200);
    }
  )
  .post(
    "/allocation-attempts/acceptance",
    describeRoute({
      description: "Accept the current pending allocation Attempt",
    }),
    validator("json", AcceptAllocationAttemptInputSchema),
    async (c) => {
      const result = await assignmentService.acceptAllocationAttempt(
        c.req.valid("json")
      );
      if (result.outcome === "CASE_MISMATCH") return c.json(result, 404);
      if (
        result.outcome === "ASSIGNMENT_NOT_PENDING" ||
        result.outcome === "ATTEMPT_NOT_PENDING" ||
        result.outcome === "ATTEMPT_NOT_OWNED"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, result.outcome === "ACCEPTED" ? 201 : 200);
    }
  )
  .post(
    "/start-work",
    describeRoute({
      description: "Start work: ACCEPTED -> IN_PROGRESS (PRS-145)",
    }),
    validator("json", MarkAssignmentInProgressInputSchema),
    async (c) => {
      const result = await assignmentService.markAssignmentInProgress(
        c.req.valid("json")
      );
      if (result.outcome === "ASSIGNMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (result.outcome === "NOT_ACCEPTED") return c.json(result, 409);
      return c.json(result, 201);
    }
  )
  .post(
    "/cancel",
    describeRoute({ description: "Cancel a pre-work Assignment for a Case" }),
    validator("json", CancelAssignmentInputSchema),
    async (c) => {
      const result = await assignmentService.cancelAssignmentForCase(
        c.req.valid("json")
      );
      if (
        result.outcome === "IN_PROGRESS" ||
        result.outcome === "NOT_CANCELLABLE"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/complete",
    describeRoute({ description: "Complete an in-progress Assignment" }),
    validator("json", CompleteAssignmentInputSchema),
    async (c) => {
      const result = await assignmentService.completeAssignment(
        c.req.valid("json")
      );
      if (result.outcome === "ASSIGNMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (result.outcome === "NOT_IN_PROGRESS") {
        return c.json(result, 409);
      }
      if (result.outcome === "COMPLETION_OPERATION_CONFLICT") {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  );

const assignmentAtomRoutes = app
  .get(
    "/health",
    describeRoute({
      description: "Service health check",
      responses: {
        200: {
          description: "Healthy",
          content: {
            "application/json": {
              schema: resolver(z.object({ status: z.string() })),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      logger.info({ route: "/health" }, "Health check verified");
      return c.json({ status: "healthy" }, 200);
    }
  )
  .route("/api/assignments", assignmentsRouter)
  .route("/internal/assignments", internalAssignmentsRouter)
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Assignment Atom API",
          version: "1.0.0",
          description: "Microservice for managing job assignments",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Server" },
        ],
      },
    })
  )
  .get(
    "/scalar",
    Scalar({
      url: "/openapi",
      theme: "deepSpace",
    })
  );

export { app };
export type AssignmentAtomType = typeof assignmentAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

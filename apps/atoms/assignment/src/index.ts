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

import { assignmentStatusHistorySelectSchema } from "./database/schema";
import { env } from "./env";
import * as assignmentService from "./service";
import {
  contractorCaseListSchema,
  getAssignmentByCaseSchema,
} from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "assignment-atom" });

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
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/contractor/:contractor_id/cases",
    describeRoute({
      description:
        "Authoritative Contractor Case scope: every Case this Contractor " +
        "has held an Attempt on, current vs historical (PRS-151)",
      responses: {
        200: {
          description: "Paginated Cases with CURRENT/HISTORICAL participation",
        },
      },
    }),
    validator("param", z.object({ contractor_id: z.uuid() }), (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
      return undefined;
    }),
    validator("query", contractorCaseListSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
      return undefined;
    }),
    async (c) => {
      const { contractor_id } = c.req.valid("param");
      const { page, pageSize } = c.req.valid("query");
      const result = await assignmentService.listCasesForContractor({
        contractorId: contractor_id,
        page,
        pageSize,
      });
      return c.json(result, 200);
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
    "/by-case/:case_id/attempts",
    describeRoute({
      description:
        "Every allocation Attempt for a Case's Assignment, oldest first " +
        "(PRS-151) — unlike /by-case/:case_id, includes BREACHED/WITHDRAWN",
      responses: {
        200: { description: "Attempt history for the Case" },
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
      const attempts = await assignmentService.getAttemptsByCaseId(case_id);
      return c.json({ attempts }, 200);
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
  );

export { app };
export type AssignmentAtomType = typeof assignmentAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

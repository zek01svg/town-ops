import { Scalar } from "@scalar/hono-api-reference";
import {
  logger,
  honoLogger,
  corsOrigins,
  initSentry,
  captureHonoException,
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
      cause: (err as any).cause?.message ?? (err as any).cause,
      route: c.req.path,
    },
    "[assignment atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger() as any);

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
      }
    ),
    validator("json", reassignAssignmentSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
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
      }
    ),
    validator("json", updateAssignmentStatusSchema, (result, c) => {
      if (!result.success) return c.json({ error: "Validation failed" }, 400);
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

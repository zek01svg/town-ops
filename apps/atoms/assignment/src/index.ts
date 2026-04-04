import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { jwk } from "hono/jwk";
import { z } from "zod/v4";

import {
  assignmentsInsertSchema,
  assignmentsSelectSchema,
} from "./database/schema";
import { env } from "./env";
import * as assignmentService from "./service";
import {
  getAssignmentByCaseSchema,
  getAssignmentByIdSchema,
  updateAssignmentStatusSchema,
} from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[assignment atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger() as any);

app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["RS256"],
  })
);

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

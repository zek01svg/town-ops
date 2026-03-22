import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-observability-ts";
import { eq } from "drizzle-orm";
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

import db from "./database/db";
import { assignments, selectAssignmentSchema } from "./database/schema";
import { env } from "./env";
import {
  assignmentsByCaseSchema,
  assignmentsByContractorSchema,
  getAssignmentByIdSchema,
  updateAssignmentStatusSchema,
  newAssignmentSchema,
} from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[assignment atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());
app.use("/api/*", jwk({ jwks_uri: env.JWKS_URI, alg: ["RS256"] }));

app
  .get(
    "/health",
    describeRoute({ description: "Service health check" }),
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .get(
    "/api/assignments",
    describeRoute({
      description: "Retrieve all assignments",
      responses: {
        200: {
          description: "List of assignments",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: z.array(selectAssignmentSchema) })
              ),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const rows = await db.select().from(assignments);
      return c.json({ assignments: rows }, 200);
    }
  )
  .get(
    "/api/assignments/:id",
    describeRoute({
      description: "Get assignment by ID",
      responses: {
        200: {
          description: "Assignment found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignment: selectAssignmentSchema })
              ),
            },
          },
        },
        404: { description: "Assignment not found" },
      },
    }),
    validator("param", getAssignmentByIdSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const rows = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, id));
      if (rows.length === 0)
        return c.json({ error: "Assignment not found" }, 404);
      return c.json({ assignment: rows[0] }, 200);
    }
  )
  .get(
    "/api/assignments/case/:caseId",
    describeRoute({
      description: "Get assignments for a case",
      responses: {
        200: {
          description: "Assignments for the case",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: z.array(selectAssignmentSchema) })
              ),
            },
          },
        },
      },
    }),
    validator("param", assignmentsByCaseSchema),
    async (c) => {
      const { caseId } = c.req.valid("param");
      const rows = await db
        .select()
        .from(assignments)
        .where(eq(assignments.caseId, caseId));
      return c.json({ assignments: rows }, 200);
    }
  )
  .get(
    "/api/assignments/contractor/:contractorId",
    describeRoute({
      description: "Get assignments by Contractor ID",
      responses: {
        200: {
          description: "Assignments for the contractor",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignments: z.array(selectAssignmentSchema) })
              ),
            },
          },
        },
      },
    }),
    validator("param", assignmentsByContractorSchema),
    async (c) => {
      const { contractorId } = c.req.valid("param");
      const rows = await db
        .select()
        .from(assignments)
        .where(eq(assignments.contractorId, contractorId));
      return c.json({ assignments: rows }, 200);
    }
  )
  .put(
    "/api/assignments/:id/status",
    describeRoute({
      description: "Update assignment status",
      responses: {
        200: {
          description: "Status updated",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignment: selectAssignmentSchema })
              ),
            },
          },
        },
      },
    }),
    validator("param", getAssignmentByIdSchema),
    validator("json", updateAssignmentStatusSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const rows = await db
        .update(assignments)
        .set({
          status: body.status,
          completedAt:
            body.status === "completed" ? new Date().toISOString() : null,
        })
        .where(eq(assignments.id, id))
        .returning();
      return c.json({ assignment: rows[0] }, 200);
    }
  )
  .post(
    "/api/assignments",
    describeRoute({
      description: "Create assignment",
      responses: {
        201: {
          description: "Assignment created",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ assignment: selectAssignmentSchema })
              ),
            },
          },
        },
      },
    }),
    validator("json", newAssignmentSchema),
    async (c) => {
      const body = c.req.valid("json");
      const rows = await db.insert(assignments).values(body).returning();
      return c.json({ assignment: rows[0] }, 201);
    }
  );

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Assignment Atom API",
        version: "1.0.0",
        description: "Standalone specs",
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: "Local Service" },
      ],
    },
  })
);

app.get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

export { app };

export default {
  port: env.PORT,
  fetch: app.fetch,
};

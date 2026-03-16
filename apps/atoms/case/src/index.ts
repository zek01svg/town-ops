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
import { z } from "zod/v4";

import db from "./database/db";
import { cases, insertCaseSchema, selectCaseSchema } from "./database/schema";
import { env } from "./env";
import { getCaseSchema, updateCaseStatusSchema } from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[case atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

app
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
  .get(
    "/api/cases",
    describeRoute({
      description: "Retrieve all cases",
      responses: {
        200: {
          description: "List of cases",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: z.array(selectCaseSchema) })),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const caseRows = await db.select().from(cases);
      logger.info(
        { route: "/api/cases", rowCount: caseRows.length },
        "Retrieved all cases"
      );
      return c.json({ cases: caseRows }, 200);
    }
  )
  .get(
    "/api/cases/:id",
    describeRoute({
      description: "Get a case by its ID",
      responses: {
        200: {
          description: "Case found",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: z.array(selectCaseSchema) })),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", z.object({ id: getCaseSchema })),
    async (c) => {
      const { id } = c.req.valid("param");
      const caseRows = await db.select().from(cases).where(eq(cases.id, id));

      logger.info(
        { route: "/api/cases/:id", caseId: id, found: caseRows.length > 0 },
        "Case lookup executed"
      );
      return c.json({ cases: caseRows }, 200);
    }
  )
  .put(
    "/api/cases/update-case-status/",
    describeRoute({
      description: "Update the status of a case",
      responses: {
        200: {
          description: "Status updated",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: selectCaseSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", updateCaseStatusSchema),
    async (c) => {
      const body = c.req.valid("json");
      const caseRows = await db
        .update(cases)
        .set({ status: body.status })
        .where(eq(cases.id, body.id))
        .returning();

      logger.info(
        {
          route: "/api/cases/update-case-status",
          caseId: body.id,
          status: body.status,
        },
        "Case status updated"
      );
      return c.json({ cases: caseRows[0] }, 200);
    }
  )
  .post(
    "/api/cases/new-case",
    describeRoute({
      description: "Create a new case ticket",
      responses: {
        201: {
          description: "Case created",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: selectCaseSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", insertCaseSchema),
    async (c) => {
      const body = c.req.valid("json");
      const caseRows = await db.insert(cases).values(body).returning();

      logger.info(
        {
          route: "/api/cases/new-case",
          caseId: caseRows[0].id,
          category: body.category,
        },
        "New case created successfully"
      );
      return c.json({ cases: caseRows[0] }, 201);
    }
  );

// OpenAPI JSON generation route
app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Case Atom API",
        version: "1.0.0",
        description: "Municipal case management backplane APIs",
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: "Local Server" },
      ],
    },
  })
);

// Scalar API Reference route
app.get(
  "/scalar",
  Scalar({
    url: "/openapi",
    theme: "deepSpace",
  })
);

export { app };

export default {
  port: env.PORT,
  fetch: app.fetch,
};

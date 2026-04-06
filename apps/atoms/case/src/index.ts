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
import { jwk } from "hono/jwk";
import { z } from "zod/v4";

import { insertCaseSchema, selectCaseSchema } from "./database/schema";
import { env } from "./env";
import * as caseService from "./service";
import { getCaseSchema, updateCaseStatusSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "case-atom" });

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
  if (
    err.message.includes("no authorization") ||
    err.message.includes("Unauthorized") ||
    err.message.includes("invalid")
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[case atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["EdDSA"],
  })
);

const casesRouter = new Hono()
  .get(
    "/",
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
      const caseRows = await caseService.getAllCases();
      logger.info(
        { route: "/api/cases", rowCount: caseRows.length },
        "Retrieved all cases"
      );
      return c.json({ cases: caseRows }, 200);
    }
  )
  .get(
    "/:id",
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
      const caseRows = await caseService.getCaseById(id);

      logger.info(
        { route: "/api/cases/:id", caseId: id, found: caseRows.length > 0 },
        "Case lookup executed"
      );
      return c.json({ cases: caseRows }, 200);
    }
  )
  .put(
    "/update-case-status",
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
      const updatedCase = await caseService.updateCaseStatus(
        body.id,
        body.status
      );

      logger.info(
        {
          route: "/api/cases/update-case-status",
          caseId: body.id,
          status: body.status,
        },
        "Case status updated"
      );
      return c.json({ cases: updatedCase }, 200);
    }
  )
  .post(
    "/new-case",
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
      const newCase = await caseService.createCase(body);

      logger.info(
        {
          route: "/api/cases/new-case",
          caseId: newCase.id,
          category: body.category,
        },
        "New case created successfully"
      );
      return c.json({ cases: newCase }, 201);
    }
  );

const caseAtomRoutes = app
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
  .route("/api/cases", casesRouter)
  .get(
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
  )
  .get(
    "/scalar",
    Scalar({
      url: "/openapi",
      theme: "deepSpace",
    })
  );

export { app };
export type CaseAtomType = typeof caseAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

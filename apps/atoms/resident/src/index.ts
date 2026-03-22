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
import { profiles, selectProfileSchema } from "./database/schema";
import { env } from "./env";
import {
  getResidentByIDSchema,
  getResidentByPostalSchema,
  newResidentSchema,
  updateResidentSchema,
} from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[resident atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

// JWK auth middleware for all api routes
app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["RS256"],
  })
);

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
    "/api/residents/search",
    describeRoute({
      description: "Get a resident by its postal code",
      responses: {
        200: {
          description: "Resident found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ residents: z.array(selectProfileSchema) })
              ),
            },
          },
        },
        400: { description: "Invalid parameters" },
      },
    }),
    validator("query", getResidentByPostalSchema),
    async (c) => {
      const { postalCode } = c.req.valid("query");
      const residentRows = await db
        .select()
        .from(profiles)
        .where(eq(profiles.postalCode, postalCode));

      logger.info(
        {
          route: "/api/residents/search",
          postalCode,
          found: residentRows.length > 0,
        },
        "Resident lookup by postal code executed"
      );
      return c.json({ residents: residentRows }, 200);
    }
  )
  .get(
    "/api/residents/:id",
    describeRoute({
      description: "Retrieve resident by ID",
      responses: {
        200: {
          description: "Resident found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ residents: z.array(selectProfileSchema) })
              ),
            },
          },
        },
      },
    }),
    validator("param", getResidentByIDSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const residentRows = await db
        .select()
        .from(profiles)
        .where(eq(profiles.id, id));
      logger.info(
        {
          route: "/api/residents/:id",
          residentId: id,
          found: residentRows.length > 0,
        },
        "Retrieved resident by ID"
      );
      return c.json({ residents: residentRows }, 200);
    }
  )
  .post(
    "/api/residents/new-resident",
    describeRoute({
      description: "Create a new resident",
      responses: {
        201: {
          description: "Resident created",
          content: {
            "application/json": {
              schema: resolver(z.object({ resident: selectProfileSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", newResidentSchema),
    async (c) => {
      const body = c.req.valid("json");
      const residentRows = await db.insert(profiles).values(body).returning();

      logger.info(
        {
          route: "/api/residents/new-resident",
          residentId: residentRows[0].id,
        },
        "New resident created"
      );
      return c.json({ resident: residentRows[0] }, 201);
    }
  )
  .put(
    "/api/residents/update-resident",
    describeRoute({
      description: "Update a resident",
      responses: {
        200: {
          description: "Resident updated",
          content: {
            "application/json": {
              schema: resolver(z.object({ resident: selectProfileSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", updateResidentSchema),
    async (c) => {
      const body = c.req.valid("json");
      const residentRows = await db
        .update(profiles)
        .set(body)
        .where(eq(profiles.id, body.id))
        .returning();

      logger.info(
        {
          route: "/api/residents/update-resident",
          residentId: body.id,
        },
        "Resident updated successfully"
      );
      return c.json({ resident: residentRows[0] }, 200);
    }
  );

// OpenAPI JSON generation route
app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Resident Atom API",
        version: "1.0.0",
        description:
          "Stand-alone microservice dedicated to managing residents details",
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

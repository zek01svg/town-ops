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

import { selectProfileSchema } from "./database/schema";
import { env } from "./env";
import * as residentService from "./service";
import {
  getResidentByIDSchema,
  getResidentByPostalSchema,
  newResidentSchema,
  updateResidentSchema,
} from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "resident-atom" });

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
    { error: err.message, stack: err.stack, route: c.req.path },
    "[resident atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

const residentRouter = new Hono()
  .get(
    "/search",
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
      const residentRows =
        await residentService.getResidentsByPostalCode(postalCode);

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
    "/:id",
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
      const residentRows = await residentService.getResidentById(id);
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
    "/new-resident",
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
      const resident = await residentService.createResident(body);

      logger.info(
        {
          route: "/api/residents/new-resident",
          residentId: resident.id,
        },
        "New resident created"
      );
      return c.json({ resident }, 201);
    }
  )
  .put(
    "/update-resident",
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
      const resident = await residentService.updateResident(body.id, body);

      logger.info(
        {
          route: "/api/residents/update-resident",
          residentId: body.id,
        },
        "Resident updated successfully"
      );
      return c.json({ resident }, 200);
    }
  );

const residentApiRoutes = app
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
  .route("/api/residents", residentRouter)
  .get(
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
  )
  .get(
    "/scalar",
    Scalar({
      url: "/openapi",
      theme: "deepSpace",
    })
  );

export { app };

export type ResidentAtomType = typeof residentApiRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

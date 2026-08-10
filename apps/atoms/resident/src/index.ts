import { ProvisionResidentInputSchema } from "@townops/orchestration-contract";
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

import { selectProfileSchema } from "./database/schema";
import { env } from "./env";
import * as residentService from "./service";
import { getResidentByIDSchema } from "./validation-schemas";

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
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
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
  );

const internalResidentsRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/:id/contact",
    validator("param", z.object({ id: z.uuid() })),
    async (c) => {
      const contact = await residentService.getResidentContact(
        c.req.valid("param").id
      );
      if (!contact) return c.json({ error: "Resident not found" }, 404);
      return c.json({ contact }, 200);
    }
  )
  .post("/", validator("json", ProvisionResidentInputSchema), async (c) => {
    const body = c.req.valid("json");
    const resident = await residentService.ensureResidentProfile(body);

    if (!resident) {
      return c.json(
        { error: "Resident email is already linked to another Account" },
        409
      );
    }

    return c.json({ resident }, 201);
  });

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
  .route("/internal/residents", internalResidentsRouter)
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
  );

export { app };

export type ResidentAtomType = typeof residentApiRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

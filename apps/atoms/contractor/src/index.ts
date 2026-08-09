import {
  captureHonoException,
  corsOrigins,
  honoLogger,
  initSentry,
  logger,
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

import { env } from "./env";
import * as contractorService from "./service";
import { contractorIdSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "contractor-atom" });

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
    "[contractor atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

// ─── /internal/contractors (Worker-only, PRS-139) ────────────────────────────

const eligibleQuerySchema = z.object({
  category: z.string().min(1),
  sector: z.string().min(1),
});

const internalContractorsRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/:id/contact",
    validator("param", z.object({ id: contractorIdSchema })),
    async (c) => {
      const contact = await contractorService.getContractorContact(
        c.req.valid("param").id
      );
      if (!contact) return c.json({ error: "not found" }, 404);
      return c.json({ contact }, 200);
    }
  )
  .get(
    "/eligible",
    describeRoute({
      description:
        "Active Contractors eligible for a Case's category and postal sector",
      responses: {
        200: {
          description: "Eligible contractors",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  contractors: z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      isActive: z.boolean(),
                    })
                  ),
                })
              ),
            },
          },
        },
      },
    }),
    validator("query", eligibleQuerySchema),
    async (c) => {
      const { category, sector } = c.req.valid("query");
      const eligible = await contractorService.getEligibleContractors({
        category,
        sector,
      });
      logger.info(
        { category, sector, count: eligible.length },
        "eligible contractors looked up"
      );
      return c.json({ contractors: eligible }, 200);
    }
  );

// ─── App assembly ─────────────────────────────────────────────────────────────

const contractorAtomRoutes = app
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
      logger.info({ route: "/health" }, "health check verified");
      return c.json({ status: "healthy" }, 200);
    }
  )
  .route("/internal/contractors", internalContractorsRouter)
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Contractor Atom API",
          version: "1.0.0",
          description:
            "Contractor management — search by sector/category, full CRUD, category and sector assignment",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Server" },
        ],
      },
    })
  );

export { app };
export type ContractorAtomType = typeof contractorAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

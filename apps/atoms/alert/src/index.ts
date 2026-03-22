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
import { alerts, selectAlertSchema } from "./database/schema";
import { env } from "./env";
import {
  alertsByCaseSchema,
  alertsByRecipientSchema,
} from "./validation-schemas";
import { startAlertQueueWorker } from "./worker";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[alert atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

// jwt auth middleware except health & api documentation
app.use("/api/*", jwk({ jwks_uri: env.JWKS_URI, alg: ["RS256"] }));

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
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .get(
    "/api/alerts",
    describeRoute({
      description: "Retrieve all alerts",
      responses: {
        200: {
          description: "List of alerts",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const alertRows = await db.select().from(alerts);
      logger.info(
        { route: "/api/alerts", rowCount: alertRows.length },
        "Retrieved all alerts"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  )
  .get(
    "/api/alerts/case/:caseId",
    describeRoute({
      description: "Get alerts by Case ID",
      responses: {
        200: {
          description: "Alerts found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", alertsByCaseSchema),
    async (c) => {
      const { caseId } = c.req.valid("param");
      const alertRows = await db
        .select()
        .from(alerts)
        .where(eq(alerts.caseId, caseId));
      logger.info(
        { route: "/api/alerts/case/:caseId", caseId },
        "Alert lookup executed by Case"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  )
  .get(
    "/api/alerts/recipient/:recipientId",
    describeRoute({
      description: "Get alerts by Recipient ID",
      responses: {
        200: {
          description: "Alerts found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", alertsByRecipientSchema),
    async (c) => {
      const { recipientId } = c.req.valid("param");
      const alertRows = await db
        .select()
        .from(alerts)
        .where(eq(alerts.recipientId, recipientId));
      logger.info(
        { route: "/api/alerts/recipient/:recipientId", recipientId },
        "Alert lookup executed by Recipient"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  );

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Alert Atom API",
        version: "1.0.0",
        description: "Standalone Specs for audit tracking alerts history",
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: "Local Service" },
      ],
    },
  })
);

app.get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

startAlertQueueWorker();

export { app };

export default {
  port: env.PORT,
  fetch: app.fetch,
};

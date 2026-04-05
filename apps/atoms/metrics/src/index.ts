import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger, corsOrigins } from "@townops/shared-ts";
import { createInsertSchema } from "drizzle-zod";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { cors } from "hono/cors";
import { jwk } from "hono/jwk";

import { contractorMetrics } from "./database/schema";
import { env } from "./env";
import * as metricsService from "./service";
import { getMetricSchema } from "./validation-schemas";

const insertMetricSchema = createInsertSchema(contractorMetrics);

const app = new Hono();

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
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[metrics atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());
app.use("/api/*", jwk({ jwks_uri: env.JWKS_URI, alg: ["EdDSA"] }));

const metricsRoutes = app
  .get(
    "/health",
    describeRoute({ description: "Service health check" }),
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .get(
    "/api/metrics/:contractor_id",
    describeRoute({ description: "Get metrics for a contractor" }),
    validator("param", getMetricSchema),
    async (c) => {
      const { contractor_id } = c.req.valid("param");
      const rows = await metricsService.getMetricsByContractorId(contractor_id);
      return c.json({ metrics: rows }, 200);
    }
  )
  .post(
    "/api/metrics",
    describeRoute({ description: "Create contractor metric" }),
    validator("json", insertMetricSchema),
    async (c) => {
      const body = c.req.valid("json");
      const metric = await metricsService.createMetric(body);
      return c.json({ metric }, 201);
    }
  );

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Metrics Atom API",
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
export type MetricsAtomType = typeof metricsRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-ts";
import { eq } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { jwk } from "hono/jwk";

import db from "./database/db";
import { contractorMetrics } from "./database/schema";
import { env } from "./env";
import { getMetricSchema } from "./validation-schemas";

const insertMetricSchema = createInsertSchema(contractorMetrics);

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[metrics atom] internal server error"
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
    "/api/metrics/:contractor_id",
    describeRoute({ description: "Get metrics for a contractor" }),
    validator("param", getMetricSchema),
    async (c) => {
      const { contractor_id } = c.req.valid("param");
      const rows = await db
        .select()
        .from(contractorMetrics)
        .where(eq(contractorMetrics.contractorId, contractor_id));
      return c.json({ metrics: rows }, 200);
    }
  )
  .post(
    "/api/metrics",
    describeRoute({ description: "Create contractor metric" }),
    validator("json", insertMetricSchema),
    async (c) => {
      const body = c.req.valid("json");
      const rows = await db.insert(contractorMetrics).values(body).returning();
      return c.json({ metric: rows[0] }, 201);
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

export default {
  port: env.PORT,
  fetch: app.fetch,
};

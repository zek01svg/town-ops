import { RecordPerformanceEntryInputSchema } from "@townops/orchestration-contract";
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
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { cors } from "hono/cors";

import { env } from "./env";
import * as metricsService from "./service";

const app = new Hono();

initSentry({ serviceName: "metrics-atom" });

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
    "[metrics atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

const metricsRoutes = app.get(
  "/health",
  describeRoute({ description: "Service health check" }),
  async (c: Context) => c.json({ status: "healthy" }, 200)
);

const internalPerformanceRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/totals",
    describeRoute({ description: "Total performance score per Contractor" }),
    async (c) => {
      const totals = await metricsService.getScoreTotals();
      return c.json({ totals }, 200);
    }
  )
  .post(
    "/entries",
    describeRoute({
      description: "Record one Contractor performance entry, once per effect",
    }),
    validator("json", RecordPerformanceEntryInputSchema),
    async (c) => {
      const body = c.req.valid("json");
      const entry = await metricsService.recordPerformanceEntry(body);
      return c.json({ entry }, 201);
    }
  );

app.route("/internal/performance", internalPerformanceRouter);

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Performance Atom API",
        version: "1.0.0",
        description: "Standalone specs",
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: "Local Service" },
      ],
    },
  })
);

export { app };
export type PerformanceAtomType = typeof metricsRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

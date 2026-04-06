import { Scalar } from "@scalar/hono-api-reference";
import {
  logger,
  honoLogger,
  rabbitmqClient,
  initSentry,
  captureHonoException,
} from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import { z } from "zod/v4";

import { handleCaseOpened } from "./consumer";
import { env } from "./env";

const app = new Hono();

initSentry({ serviceName: "assign-job-composite" });

app.onError((err, c) => {
  captureHonoException(err, c);
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[assign-job composite] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

const AssignJobComposite = app
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
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Assign Job Composite Service",
          version: "1.0.0",
          description:
            "Event-driven composite service that consumes case.opened events, selects the best contractor, creates an assignment, and publishes job.assigned.",
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

// consume after app is defined
await rabbitmqClient.connect();
await rabbitmqClient.consume("assign-job-queue", handleCaseOpened);
logger.info("assign-job: consumer started on assign-job-queue");

export { app };
export type AssignJobCompositeType = typeof AssignJobComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

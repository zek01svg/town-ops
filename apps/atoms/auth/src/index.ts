import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-observability-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod/v4";

import { auth } from "./auth";
import { env } from "./env";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[auth atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.get(
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
);

// Scalar API Reference route
app.get(
  "/scalar",
  Scalar({
    url: "/api/auth/open-api/generate-schema",
    theme: "deepSpace",
  })
);

export { app };

export default {
  port: env.PORT,
  fetch: app.fetch,
};

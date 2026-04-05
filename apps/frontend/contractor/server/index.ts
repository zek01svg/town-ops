import { logger, honoLogger } from "@townops/shared-ts";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

app.use("*", honoLogger() as any);

app.get("/health", (c) => {
  return c.json(
    {
      status: "healthy",
    },
    200
  );
});

app.use("/assets/*", serveStatic({ root: "./build" }));
app.use("/*", serveStatic({ root: "./build" }));
app.get("*", serveStatic({ path: "./build/index.html" }));

const server = {
  port: 4001,
  fetch: app.fetch,
};

logger.info({
  message: "TownOps frontend for contractors is running",
  port: server.port,
});

export default server;

import { readFileSync } from "node:fs";

import {
  logger,
  honoLogger,
  initSentry,
  captureHonoException,
} from "@townops/shared-ts";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();
initSentry({ serviceName: "contractor-frontend-server" });

// Cloud Run serves one built image across every environment (PRS-140) — Vite
// bakes `import.meta.env.VITE_*` in at build time, so an environment's own
// value can only reach the browser by being injected into `index.html`
// itself. `src/env.ts` already reads `window.__env` before `import.meta.env`;
// this is what writes it, once, before the file is ever served.
// ponytail: only the three keys `src/env.ts` actually reads; a key whose
// env var is unset is omitted rather than injected as `""`, so the client's
// own `?? import.meta.env.X ?? <default>` fallback chain still runs for it.
function injectRuntimeEnv(html: string): string {
  const runtimeEnv = Object.fromEntries(
    Object.entries({
      VITE_APP_URL: process.env.VITE_APP_URL,
      VITE_GATEWAY_URL: process.env.VITE_GATEWAY_URL,
      VITE_GOOGLE_MAPS_API_KEY: process.env.VITE_GOOGLE_MAPS_API_KEY,
    }).filter(([, value]) => value)
  );
  // JSON-encoded so a value containing a quote can't break out of the
  // attribute/value position, and `<` is escaped so a value containing
  // "</script>" can't close the tag early.
  const script = `<script>window.__env=${JSON.stringify(runtimeEnv).replace(/</g, "\\u003c")}</script>`;
  return html.replace("</head>", `${script}</head>`);
}

const indexHtml = injectRuntimeEnv(readFileSync("./build/index.html", "utf-8"));

// Registered ahead of the `serveStatic` mounts below, so `/` and every other
// non-asset path are served from the (env-injected) HTML already read above
// rather than the file on disk. `/assets/*` falls through to `serveStatic`
// unchanged — it never matches `/assets/`, so the guard is only load-bearing
// on the `"*"` registration.
function serveIndex(c: Context, next: Next) {
  if (c.req.path.startsWith("/assets/")) return next();
  return c.html(indexHtml);
}

app.onError((err, c) => {
  captureHonoException(err, c);
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[contractor frontend server] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

app.get("/health", (c) => {
  return c.json(
    {
      status: "healthy",
    },
    200
  );
});

app.get("/", serveIndex);
app.get("*", serveIndex);

app.use("/assets/*", serveStatic({ root: "./build" }));
app.use("/*", serveStatic({ root: "./build" }));

const server = {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};

logger.info({
  message: "TownOps frontend for contractors is running",
  port: server.port,
});

export default server;

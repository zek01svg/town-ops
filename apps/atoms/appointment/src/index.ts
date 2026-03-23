import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-ts";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { jwk } from "hono/jwk";

import db from "./database/db";
import { appointments, appointmentInsertSchema } from "./database/schema";
import { env } from "./env";
import { getAppointmentSchema } from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[appointment atom] internal server error"
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
    "/api/appointments/:case_id",
    describeRoute({ description: "Get appointments for a case" }),
    validator("param", getAppointmentSchema),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const rows = await db
        .select()
        .from(appointments)
        .where(eq(appointments.caseId, case_id));
      return c.json({ appointments: rows }, 200);
    }
  )
  .post(
    "/api/appointments",
    describeRoute({ description: "Create appointment" }),
    validator("json", appointmentInsertSchema),
    async (c) => {
      const body = c.req.valid("json");
      const rows = await db.insert(appointments).values(body).returning();
      return c.json({ appointment: rows[0] }, 201);
    }
  );

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Appointment Atom API",
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

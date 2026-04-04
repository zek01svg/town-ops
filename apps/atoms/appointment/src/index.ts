import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { jwk } from "hono/jwk";

import { appointmentInsertSchema } from "./database/schema";
import { env } from "./env";
import * as appointmentService from "./service";
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

const appointmentRoutes = app
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
      const rows = await appointmentService.getAppointmentsByCaseId(case_id);
      return c.json({ appointments: rows }, 200);
    }
  )
  .post(
    "/api/appointments",
    describeRoute({ description: "Create appointment" }),
    validator("json", appointmentInsertSchema),
    async (c) => {
      const body = c.req.valid("json");
      const result = await appointmentService.createAppointment(body);
      return c.json({ appointment: result }, 201);
    }
  )
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Appointment Atom API",
          version: "1.0.0",
          description: "Standalone specs",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Server" },
        ],
      },
    })
  )
  .get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

export { app };
export type AppointmentAtomType = typeof appointmentRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

import { Scalar } from "@scalar/hono-api-reference";
import type { AppointmentAtomType } from "@townops/appointment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import type { ResidentAtomType } from "@townops/resident-atom";
import {
  logger,
  honoLogger,
  corsOrigins,
  initSentry,
  captureHonoException,
} from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { hc } from "hono/client";
import { cors } from "hono/cors";
import { jwk } from "hono/jwk";
import { z } from "zod/v4";

import { env } from "./env";
import { rescheduleJobSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "reschedule-job-composite" });

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
    "[reschedule-job composite] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["EdDSA"],
  })
);

const RescheduleJobComposite = app
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
  .post(
    "/api/cases/reschedule-job",
    describeRoute({
      description:
        "Reschedule a job appointment: verifies resident, creates a new appointment slot, and restores case status to dispatched.",
      responses: {
        200: {
          description: "Appointment rescheduled successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  appointmentId: z.uuid(),
                  caseId: z.uuid(),
                  status: z.string(),
                  message: z.string(),
                  newStartTime: z.string(),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed" },
        404: { description: "Resident not found" },
        422: { description: "Resident is not active" },
        503: { description: "Downstream service unavailable" },
      },
    }),
    validator("json", rescheduleJobSchema, (result, c) => {
      if (!result.success) {
        logger.warn(
          { error: result.error, route: "/api/cases/reschedule-job" },
          "Validation failed for reschedule-job request"
        );
        return c.json(
          { error: "Validation failed", details: result.error },
          400
        );
      }
      return undefined;
    }),
    async (c) => {
      const body = c.req.valid("json");
      const authHeader = c.req.header("Authorization") ?? "";

      logger.info(
        {
          route: "/api/cases/reschedule-job",
          caseId: body.caseId,
          residentId: body.residentId,
        },
        "Processing reschedule-job request"
      );

      const residentClient = hc<ResidentAtomType>(env.RESIDENT_ATOM_URL);
      const appointmentClient = hc<AppointmentAtomType>(
        env.APPOINTMENT_ATOM_URL
      );
      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);

      // ── Step 1: Verify resident exists and is active ──────────────────────
      const residentRes = await residentClient.api.residents[":id"].$get(
        { param: { id: body.residentId } },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!residentRes.ok) {
        logger.warn({ residentId: body.residentId }, "Resident not found");
        return c.json({ error: "Resident not found" }, 404);
      }

      const residentData = (await residentRes.json()) as any;
      const resident = residentData.residents ?? residentData;
      const residentRecord = Array.isArray(resident) ? resident[0] : resident;

      if (residentRecord?.is_active === false) {
        logger.warn({ residentId: body.residentId }, "Resident is not active");
        return c.json({ error: "Resident is not active" }, 422);
      }

      // ── Step 2: Create new appointment slot ───────────────────────────────
      const appointmentRes = await appointmentClient.api.appointments.$post(
        {
          json: {
            caseId: body.caseId,
            assignmentId: body.assignmentId,
            startTime: body.newStartTime,
            endTime: body.newEndTime,
            status: "rescheduled",
          },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!appointmentRes.ok) {
        logger.error(
          { caseId: body.caseId },
          "Step 2 failed: appointment creation"
        );
        return c.json({ error: "Failed to create appointment" }, 503);
      }

      const appointmentData = (await appointmentRes.json()) as any;
      const newAppointment = appointmentData.appointment ?? appointmentData;

      // ── Step 3: Restore case status → dispatched ──────────────────────────
      const caseRes = await caseClient.api.cases["update-case-status"].$put(
        {
          json: { id: body.caseId, status: "dispatched" },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseRes.ok) {
        logger.error(
          { caseId: body.caseId },
          "Step 3 failed: case status update"
        );
        return c.json({ error: "Failed to update case status" }, 503);
      }

      logger.info(
        { caseId: body.caseId },
        "reschedule-job: success — appointment rescheduled"
      );

      return c.json(
        {
          appointmentId: newAppointment.id,
          caseId: body.caseId,
          status: "rescheduled",
          message: "Appointment successfully rescheduled",
          newStartTime: body.newStartTime,
        },
        200
      );
    }
  )
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Reschedule Job Composite Service",
          version: "1.0.0",
          description:
            "Composite service for rescheduling appointments: verifies resident, creates a new appointment slot, and restores case status.",
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

export { app };
export type RescheduleJobCompositeType = typeof RescheduleJobComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

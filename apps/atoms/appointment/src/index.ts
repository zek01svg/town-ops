import { Scalar } from "@scalar/hono-api-reference";
import {
  ConfirmAppointmentSlotInputSchema,
  CompleteAppointmentInputSchema,
  ReleaseAppointmentSlotInputSchema,
  MarkAppointmentMissedInputSchema,
  ReplaceAppointmentSlotInputSchema,
  ReportNoAccessAppointmentInputSchema,
  ReserveAppointmentSlotInputSchema,
  StartWorkAppointmentInputSchema,
} from "@townops/orchestration-contract";
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
import { z } from "zod/v4";

import { appointmentInsertSchema } from "./database/schema";
import { env } from "./env";
import * as appointmentService from "./service";
import { getAppointmentSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "appointment-atom" });

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
    "[appointment atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

const appointmentSlotRoutes = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/completion-operation/:appointmentId",
    validator("param", z.object({ appointmentId: z.uuid() })),
    async (c) => {
      const identity =
        await appointmentService.getAppointmentCompletionOperation(
          c.req.valid("param").appointmentId
        );
      if (!identity) {
        return c.json({ error: "Appointment was not found" }, 404);
      }
      return c.json(identity, 200);
    }
  )
  .post(
    "/reservations",
    validator("json", ReserveAppointmentSlotInputSchema),
    async (c) => {
      const result = await appointmentService.reserveAppointmentSlot(
        c.req.valid("json")
      );
      if (result.outcome === "CONFLICT") {
        return c.json(
          { error: "Appointment slot overlaps an active reservation" },
          409
        );
      }
      if (result.outcome === "PAST") {
        return c.json({ error: "Appointment slot must be in the future" }, 400);
      }
      return c.json({ claim: result.claim }, 201);
    }
  )
  .post(
    "/confirmations",
    validator("json", ConfirmAppointmentSlotInputSchema),
    async (c) => {
      const result = await appointmentService.confirmAppointmentSlot(
        c.req.valid("json")
      );
      if (result.outcome !== "CONFIRMED") {
        return c.json(
          { error: "Appointment slot is not available to confirm" },
          409
        );
      }
      return c.json({ appointment: result.appointment }, 201);
    }
  )
  .post(
    "/releases",
    validator("json", ReleaseAppointmentSlotInputSchema),
    async (c) => {
      const result = await appointmentService.releaseAppointmentSlot(
        c.req.valid("json")
      );
      if (result.outcome === "CLAIM_ACTIVE") {
        return c.json(
          { error: "Active appointment slots cannot be released" },
          409
        );
      }
      if (result.outcome === "CLAIM_NOT_FOUND") {
        return c.json({ error: "Appointment slot claim was not found" }, 404);
      }
      return c.json({ outcome: result.outcome }, 200);
    }
  )
  .post(
    "/start-work",
    validator("json", StartWorkAppointmentInputSchema),
    async (c) => {
      const result = await appointmentService.startWorkAppointment(
        c.req.valid("json")
      );
      if (result.outcome === "APPOINTMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (
        result.outcome === "NOT_SCHEDULED" ||
        result.outcome === "WRONG_CONTRACTOR"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/complete",
    validator("json", CompleteAppointmentInputSchema),
    async (c) => {
      const result = await appointmentService.completeAppointment(
        c.req.valid("json")
      );
      if (result.outcome === "APPOINTMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (
        result.outcome === "NOT_IN_PROGRESS" ||
        result.outcome === "WRONG_CONTRACTOR" ||
        result.outcome === "COMPLETION_OPERATION_CONFLICT"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/no-access",
    validator("json", ReportNoAccessAppointmentInputSchema),
    async (c) => {
      const result = await appointmentService.reportNoAccessAppointment(
        c.req.valid("json")
      );
      if (result.outcome === "APPOINTMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (
        result.outcome === "NOT_SCHEDULED" ||
        result.outcome === "WRONG_CONTRACTOR"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/missed",
    validator("json", MarkAppointmentMissedInputSchema),
    async (c) => {
      const result = await appointmentService.markAppointmentMissed(
        c.req.valid("json")
      );
      if (result.outcome === "APPOINTMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (result.outcome === "NOT_SCHEDULED") {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  )
  .post(
    "/replacements",
    validator("json", ReplaceAppointmentSlotInputSchema),
    async (c) => {
      const result = await appointmentService.replaceAppointmentSlot(
        c.req.valid("json")
      );
      if (result.outcome === "APPOINTMENT_NOT_FOUND") {
        return c.json(result, 404);
      }
      if (
        result.outcome === "NOT_REPLACEABLE" ||
        result.outcome === "CASE_MISMATCH" ||
        result.outcome === "CONFLICT"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  );

app.route("/internal/appointment-slots", appointmentSlotRoutes);

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

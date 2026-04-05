import { Scalar } from "@scalar/hono-api-reference";
import type { AppointmentAtomType } from "@townops/appointment-atom";
import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import { logger, honoLogger } from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { hc } from "hono/client";
import { jwk } from "hono/jwk";
import { z } from "zod/v4";

import { env } from "./env";
import { acceptJobSchema } from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[accept-job composite] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["RS256"],
  })
);

const AcceptJobComposite = app
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
  .put(
    "/api/jobs/accept-job",
    describeRoute({
      description:
        "Accept a contractor job: updates assignment, transitions case to in_progress, and creates an appointment block. Supports compensating transactions.",
      responses: {
        200: {
          description: "Job accepted successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  message: z.string(),
                  assignment: z.record(z.string(), z.unknown()),
                  case: z.record(z.string(), z.unknown()),
                  appointment: z.record(z.string(), z.unknown()),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed" },
        503: { description: "Downstream service unavailable" },
      },
    }),
    validator("json", acceptJobSchema, (result, c) => {
      if (!result.success) {
        logger.warn(
          { error: result.error, route: "/api/jobs/accept-job" },
          "Validation failed for accept-job request"
        );
        return c.json(
          { error: "Validation failed", details: result.error },
          400
        );
      }
    }),
    async (c) => {
      const body = c.req.valid("json");
      const authHeader = c.req.header("Authorization") ?? "";

      logger.info(
        {
          route: "/api/jobs/accept-job",
          caseId: body.case_id,
          assignmentId: body.assignment_id,
          contractorId: body.contractor_id,
        },
        "Processing accept-job request"
      );

      const assignmentClient = hc<AssignmentAtomType>(env.ASSIGNMENT_ATOM_URL);
      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);
      const appointmentClient = hc<AppointmentAtomType>(
        env.APPOINTMENT_ATOM_URL
      );

      // ── Step 1: Update Assignment status → accepted
      const assignmentRes = await assignmentClient.api.assignments[
        ":id"
      ].status.$put(
        {
          param: { id: body.assignment_id },
          json: { status: "ACCEPTED", changedBy: body.contractor_id },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!assignmentRes.ok) {
        logger.error(
          { assignmentId: body.assignment_id },
          "Step 1 failed: assignment status update"
        );
        return c.json({ error: "Failed to update assignment" }, 503);
      }

      const assignmentData = await assignmentRes.json();

      // ── Step 2: Update Case status → in_progress ─────────────────────────
      const caseRes = await caseClient.api.cases["update-case-status"].$put(
        {
          json: { id: body.case_id, status: "in_progress" },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseRes.ok) {
        logger.error(
          { caseId: body.case_id },
          "Step 2 failed: case status update — initiating rollback"
        );
        // Compensate: revert assignment to pending
        await assignmentClient.api.assignments[":id"].status.$put(
          {
            param: { id: body.assignment_id },
            json: {
              status: "PENDING_ACCEPTANCE",
              changedBy: body.contractor_id,
            },
          },
          { headers: { Authorization: authHeader } }
        );
        return c.json({ error: "Failed to update case status" }, 503);
      }

      const caseData = await caseRes.json();

      // ── Step 3: Create Appointment schedule block ─────────────────────────
      const appointmentRes = await appointmentClient.api.appointments.$post(
        {
          json: {
            caseId: body.case_id,
            assignmentId: body.assignment_id,
            startTime: body.start_time,
            endTime: body.end_time,
            status: "scheduled",
          },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!appointmentRes.ok) {
        logger.error(
          { caseId: body.case_id },
          "Step 3 failed: appointment creation — initiating full rollback"
        );
        // Compensate: revert case to dispatched
        await caseClient.api.cases["update-case-status"].$put(
          {
            json: { id: body.case_id, status: "dispatched" },
          },
          { headers: { Authorization: authHeader } }
        );
        // Compensate: revert assignment to pending
        await assignmentClient.api.assignments[":id"].status.$put(
          {
            param: { id: body.assignment_id },
            json: {
              status: "PENDING_ACCEPTANCE",
              changedBy: body.contractor_id,
            },
          },
          { headers: { Authorization: authHeader } }
        );
        return c.json({ error: "Failed to create appointment" }, 503);
      }

      const appointmentData = await appointmentRes.json();

      logger.info(
        { caseId: body.case_id },
        "accept-job: success — appointment created"
      );

      return c.json(
        {
          message: "Job accepted successfully",
          assignment: assignmentData.assignments,
          case: caseData.cases,
          appointment: appointmentData.appointment,
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
          title: "Accept Job Composite Service",
          version: "1.0.0",
          description:
            "Composite service that accepts a contractor job: updates assignment, transitions case to in_progress, and creates an appointment block.",
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
export type AcceptJobCompositeType = typeof AcceptJobComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

import { Scalar } from "@scalar/hono-api-reference";
import type { AssignmentAtomType } from "@townops/assignment-atom";
import type { CaseAtomType } from "@townops/case-atom";
import type { MetricsAtomType } from "@townops/metrics-atom";
import {
  logger,
  honoLogger,
  rabbitmqClient,
  corsOrigins,
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
import { handleBreachSchema } from "./validation-schemas";
import { handleSlaBreach } from "./worker";

const app = new Hono();

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
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[handle-breach composite] internal server error"
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

const HandleBreachComposite = app
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
    "/api/assignments/handle-breach",
    describeRoute({
      description:
        "Manually trigger a breach handler: escalates the case, reassigns the job, and records a penalty.",
      responses: {
        200: {
          description: "Breach handled successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.boolean(),
                  assignment: z.record(z.string(), z.unknown()),
                  case: z.record(z.string(), z.unknown()),
                  metrics: z.record(z.string(), z.unknown()),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed" },
        500: { description: "Downstream operation failed" },
      },
    }),
    validator("json", handleBreachSchema, (result, c) => {
      if (!result.success) {
        logger.warn(
          { error: result.error, route: "/api/assignments/handle-breach" },
          "Validation failed for handle-breach request"
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
          route: "/api/assignments/handle-breach",
          caseId: body.case_id,
          assignmentId: body.assignment_id,
        },
        "Processing handle-breach request"
      );

      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);
      const assignmentClient = hc<AssignmentAtomType>(env.ASSIGNMENT_ATOM_URL);
      const metricsClient = hc<MetricsAtomType>(env.METRICS_ATOM_URL);

      // Step 1: Update Case status → escalated
      const caseRes = await caseClient.api.cases["update-case-status"].$put(
        {
          json: { id: body.case_id, status: "escalated" },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseRes.ok) {
        logger.error(
          { caseId: body.case_id },
          "Step 1 failed: case escalation"
        );
        return c.json({ error: "Failed to escalate case" }, 500);
      }
      const caseData = (await caseRes.json()) as any;

      // Step 2: Update Assignment → REASSIGNED to new assignee
      const assignmentRes = await assignmentClient.api.assignments[
        ":id"
      ].status.$put(
        {
          param: { id: body.assignment_id },
          json: {
            status: "REASSIGNED",
            changedBy: body.new_assignee_id,
            reason: body.breach_details,
          },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!assignmentRes.ok) {
        logger.error(
          { assignmentId: body.assignment_id },
          "Step 2 failed: assignment reassignment"
        );
        return c.json({ error: "Failed to reassign assignment" }, 500);
      }
      const assignmentData = (await assignmentRes.json()) as any;

      // Step 3: Record penalty in Metrics
      const metricsRes = await metricsClient.api.metrics.$post(
        {
          json: {
            contractorId: body.new_assignee_id,
            scoreDelta: -body.penalty,
            reason: "SLA_BREACH",
          },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!metricsRes.ok) {
        logger.error(
          { assignmentId: body.assignment_id },
          "Step 3 failed: penalty recording"
        );
        return c.json({ error: "Failed to record penalty" }, 500);
      }
      const metricsData = (await metricsRes.json()) as any;

      logger.info(
        { caseId: body.case_id },
        "handle-breach: manual breach handled successfully"
      );

      return c.json(
        {
          success: true,
          case: caseData.cases ?? caseData,
          assignment: assignmentData.assignments ?? assignmentData,
          metrics: metricsData.metric ?? metricsData,
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
          title: "Handle Breach Composite Service",
          version: "1.0.0",
          description:
            "Hybrid composite service: HTTP endpoint for manual breach handling and AMQP consumer for automated SLA breach processing.",
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

// consume after server is ready
await rabbitmqClient.connect();
await rabbitmqClient.consume("handle-breach-queue", handleSlaBreach);
logger.info("handle-breach: consumer started on handle-breach-queue");

export { app };
export type HandleBreachCompositeType = typeof HandleBreachComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

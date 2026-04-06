import { Scalar } from "@scalar/hono-api-reference";
import type { CaseAtomType } from "@townops/case-atom";
import type { ResidentAtomType } from "@townops/resident-atom";
import {
  logger,
  honoLogger,
  corsOrigins,
  rabbitmqClient,
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
import { handleNoAccessSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "handle-no-access-composite" });

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
    "[handle-no-access composite] internal server error"
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

const HandleNoAccessComposite = app
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
    "/api/cases/no-access",
    describeRoute({
      description:
        "Report no access: update case status and notify resident to reschedule.",
      responses: {
        200: {
          description: "Case updated and resident notified",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.boolean(),
                  caseId: z.uuid(),
                  status: z.string(),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed" },
        404: { description: "Case or resident not found" },
        503: { description: "Downstream service unavailable" },
      },
    }),
    validator("json", handleNoAccessSchema, (result, c) => {
      if (!result.success) {
        logger.warn(
          { error: result.error, route: "/api/cases/no-access" },
          "Validation failed for no-access request"
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

      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);
      const residentClient = hc<ResidentAtomType>(env.RESIDENT_ATOM_URL);

      const caseRes = await caseClient.api.cases[":id"].$get(
        { param: { id: body.caseId } },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseRes.ok) {
        logger.warn({ caseId: body.caseId }, "Case not found");
        return c.json({ error: "Case not found" }, 404);
      }

      const caseData = (await caseRes.json()) as any;
      const caseRows = caseData.cases ?? caseData;
      const caseRecord = Array.isArray(caseRows) ? caseRows[0] : caseRows;
      if (!caseRecord) {
        return c.json({ error: "Case not found" }, 404);
      }

      const residentId =
        caseRecord.residentId ?? caseRecord.resident_id ?? null;
      if (!residentId) {
        return c.json({ error: "Resident not found" }, 404);
      }

      const residentRes = await residentClient.api.residents[":id"].$get(
        { param: { id: residentId } },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!residentRes.ok) {
        logger.warn({ residentId }, "Resident not found");
        return c.json({ error: "Resident not found" }, 404);
      }

      const residentData = (await residentRes.json()) as any;
      const residentRows = residentData.residents ?? residentData;
      const residentRecord = Array.isArray(residentRows)
        ? residentRows[0]
        : residentRows;

      const updateRes = await caseClient.api.cases["update-case-status"].$put(
        {
          json: { id: body.caseId, status: "pending_resident_input" },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!updateRes.ok) {
        logger.error({ caseId: body.caseId }, "Failed to update case status");
        return c.json({ error: "Failed to update case status" }, 503);
      }

      await rabbitmqClient.publish("townops.events", "case.no_access", {
        caseId: body.caseId,
        residentId,
        email: residentRecord?.email,
        message:
          body.reason ??
          "Access issue reported. Please reschedule your appointment.",
      });

      logger.info(
        { caseId: body.caseId, residentId },
        "handle-no-access: resident notified"
      );

      return c.json(
        {
          success: true,
          caseId: body.caseId,
          status: "pending_resident_input",
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
          title: "Handle No Access Composite Service",
          version: "1.0.0",
          description:
            "Composite service that handles no-access reporting and notifies residents to reschedule.",
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
export type HandleNoAccessCompositeType = typeof HandleNoAccessComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

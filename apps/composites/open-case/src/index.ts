import { Scalar } from "@scalar/hono-api-reference";
import type { CaseAtomType } from "@townops/case-atom";
import type { ResidentAtomType } from "@townops/resident-atom";
import { logger, honoLogger, rabbitmqClient } from "@townops/shared-ts";
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
import { openCaseSchema } from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[open case composite] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

app.use(
  "/api/*",
  jwk({
    jwks_uri: env.JWKS_URI,
    alg: ["RS256"],
  })
);

const OpenCaseComposite = app
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
    "/api/cases/open-case",
    describeRoute({
      description: "Open a new case (Verifies resident and creates case)",
      responses: {
        201: {
          description: "Case opened successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  message: z.string(),
                  case: z.object({
                    id: z.uuid(),
                    resident_id: z.uuid(),
                    category: z.string(),
                    priority: z.enum(["low", "medium", "high", "emergency"]),
                    status: z.string(),
                    description: z.string().nullable(),
                    created_at: z.string(),
                  }),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed or resident not found" },
        500: { description: "Internal Server Error" },
      },
    }),
    validator("json", openCaseSchema, (result, c) => {
      if (!result.success) {
        logger.warn(
          { error: result.error, route: "/api/cases/open-case" },
          "Validation failed for open case request"
        );
        return c.json(
          { error: "Validation failed", details: result.error },
          400
        );
      }
    }),
    async (c) => {
      const body = c.req.valid("json");
      logger.info(
        {
          route: "/api/cases/open-case",
          residentId: body.resident_id,
        },
        "Processing open case request"
      );

      // 1. Verify resident exists
      const residentClient = hc<ResidentAtomType>(env.RESIDENT_ATOM_URL);
      const residentResponse = await residentClient.api.residents[":id"].$get(
        {
          param: { id: body.resident_id },
        },
        {
          headers: {
            Authorization: c.req.header("Authorization") ?? "",
          },
        }
      );
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!residentResponse.ok) {
        return c.json({ error: "Resident not found" }, 400);
      }
      // 2. Create case
      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);
      const caseResponse = await caseClient.api.cases["new-case"].$post(
        {
          json: {
            residentId: body.resident_id,
            category: body.category as any,
            priority: body.priority,
            description: body.description,
            addressDetails: body.address_details,
          },
        },
        {
          headers: {
            Authorization: c.req.header("Authorization") ?? "",
          },
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseResponse.ok) {
        return c.json({ error: "Failed to create case" }, 500);
      }

      const caseData = (await caseResponse.json()) as any;
      const newCase = caseData.cases;

      // 3. Publish a case.opened event to the townops.events exchange
      await rabbitmqClient.publish("townops.events", "case.opened", {
        caseId: newCase.id,
        residentId: body.resident_id,
        category: body.category,
        priority: body.priority,
        description: body.description ?? undefined,
        addressDetails: body.address_details,
      });

      return c.json(
        {
          message: "Case opened successfully",
          case: {
            id: newCase.id,
            resident_id: body.resident_id,
            category: body.category,
            priority: body.priority,
            status: "pending",
            description: body.description ?? null,
            created_at: new Date().toISOString(),
          },
        },
        201
      );
    }
  )
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Open Case Composite Service",
          version: "1.0.0",
          description: "Composite Service for opening a case",
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
export type OpenCaseCompositeType = typeof OpenCaseComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

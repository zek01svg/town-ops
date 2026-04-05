import { Scalar } from "@scalar/hono-api-reference";
import type { CaseAtomType } from "@townops/case-atom";
import type { ProofAtomType } from "@townops/proof-atom";
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
import { closeCaseSchema } from "./validation-schemas";

const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[close-case composite] internal server error"
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

const CloseCaseComposite = app
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
    "/api/cases/close-case",
    describeRoute({
      description:
        "Close a case: verifies the case exists, stores proof items, updates case status to completed, and emits a job.done event (non-fatal).",
      responses: {
        200: {
          description: "Case closed successfully",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  success: z.boolean(),
                  case_id: z.uuid(),
                  message: z.string(),
                  proof_stored: z.number(),
                })
              ),
            },
          },
        },
        400: { description: "Validation failed" },
        404: { description: "Case not found" },
        502: { description: "Downstream service error" },
        503: { description: "Downstream service unavailable" },
      },
    }),
    validator("json", closeCaseSchema, (result, c) => {
      if (!result.success) {
        console.error(
          "VALIDATION FAILED",
          JSON.stringify(result.error, null, 2)
        );
        logger.warn(
          { error: result.error, route: "/api/cases/close-case" },
          "Validation failed for close-case request"
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
          route: "/api/cases/close-case",
          caseId: body.case_id,
          uploaderId: body.uploader_id,
          proofCount: body.proof_items.length,
        },
        "Processing close-case request"
      );

      const caseClient = hc<CaseAtomType>(env.CASE_ATOM_URL);
      const proofClient = hc<ProofAtomType>(env.PROOF_ATOM_URL);

      // ── Step 1: Verify case exists ────────────────────────────────────────
      const caseGetRes = await caseClient.api.cases[":id"].$get(
        { param: { id: body.case_id } },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseGetRes.ok) {
        if ((caseGetRes.status as number) === 404) {
          logger.warn({ caseId: body.case_id }, "Case not found");
          return c.json({ error: `Case ${body.case_id} not found` }, 404);
        }
        logger.error(
          { caseId: body.case_id },
          "Case service error during verification"
        );
        return c.json({ error: "Case service returned an error" }, 502);
      }

      // ── Step 2: Store proof items ─────────────────────────────────────────
      const proofRes = await proofClient.api.proof.batch.$post(
        {
          json: {
            caseId: body.case_id,
            uploaderId: body.uploader_id,
            items: body.proof_items.map((item) => ({
              mediaUrl: item.media_url,
              type: item.type,
              remarks: item.remarks,
            })),
          },
        },
        { headers: { Authorization: authHeader } }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!proofRes.ok) {
        logger.error(
          { caseId: body.case_id, status: proofRes.status },
          "Proof service failed to store evidence"
        );
        return c.json({ error: "Proof service failed to store evidence" }, 502);
      }

      // Step 3: Update case status to completed
      const caseUpdateRes = await caseClient.api.cases[
        "update-case-status"
      ].$put(
        {
          json: {
            id: body.case_id,
            status: body.final_status,
          },
        },
        {
          headers: {
            Authorization: authHeader,
          },
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!caseUpdateRes.ok) {
        logger.error(
          { caseId: body.case_id, status: caseUpdateRes.status },
          "Case service failed to update status"
        );
        return c.json({ error: "Case service failed to update status" }, 502);
      }

      // ── Step 4: Publish job.done event (non-fatal) ────────────────────────
      try {
        await rabbitmqClient.publish("townops.events", "job.done", {
          caseId: body.case_id,
          uploaderId: body.uploader_id,
        });
      } catch (err) {
        logger.error(
          { error: (err as Error).message, caseId: body.case_id },
          "Failed to publish job.done event (non-fatal)"
        );
      }

      logger.info({ caseId: body.case_id }, "Case closed successfully");

      return c.json(
        {
          success: true,
          case_id: body.case_id,
          message: `Case ${body.case_id} has been closed successfully.`,
          proof_stored: body.proof_items.length,
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
          title: "Close Case Composite Service",
          version: "1.0.0",
          description:
            "Composite service that stores completion proof, closes the case, and emits a Job_Done event.",
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
export type CloseCaseCompositeType = typeof CloseCaseComposite;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

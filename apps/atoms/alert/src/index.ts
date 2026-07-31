import { Scalar } from "@scalar/hono-api-reference";
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
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import { selectAlertSchema } from "./database/schema";
import { env } from "./env";
import { sendEmail } from "./mailer";
import * as alertService from "./service";
import {
  alertsByCaseSchema,
  alertsByRecipientSchema,
  effectIdSchema,
  failEffectSchema,
  reserveEffectSchema,
} from "./validation-schemas";
import { startAlertQueueWorker } from "./worker";

const app = new Hono();

initSentry({ serviceName: "alert-atom" });

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
    "[alert atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

const alertRoutes = app
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
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .get(
    "/api/alerts",
    describeRoute({
      description: "Retrieve all alerts",
      responses: {
        200: {
          description: "List of alerts",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const alertRows = await alertService.getAllAlerts();
      logger.info(
        { route: "/api/alerts", rowCount: alertRows.length },
        "Retrieved all alerts"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  )
  .get(
    "/api/alerts/case/:caseId",
    describeRoute({
      description: "Get alerts by Case ID",
      responses: {
        200: {
          description: "Alerts found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", alertsByCaseSchema),
    async (c) => {
      const { caseId } = c.req.valid("param");
      const alertRows = await alertService.getAlertsByCaseId(caseId);
      logger.info(
        { route: "/api/alerts/case/:caseId", caseId },
        "Alert lookup executed by Case"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  )
  .get(
    "/api/alerts/recipient/:recipientId",
    describeRoute({
      description: "Get alerts by Recipient ID",
      responses: {
        200: {
          description: "Alerts found",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ alerts: z.array(selectAlertSchema) })
              ),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", alertsByRecipientSchema),
    async (c) => {
      const { recipientId } = c.req.valid("param");
      const alertRows = await alertService.getAlertsByRecipientId(recipientId);
      logger.info(
        { route: "/api/alerts/recipient/:recipientId", recipientId },
        "Alert lookup executed by Recipient"
      );
      return c.json({ alerts: alertRows }, 200);
    }
  )
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Alert Atom API",
          version: "1.0.0",
          description: "Standalone Specs for audit tracking alerts history",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Service" },
        ],
      },
    })
  )
  .get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

const internalEffectsRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .post("/reserve", validator("json", reserveEffectSchema), async (c) => {
    const input = c.req.valid("json");
    try {
      const effect = await alertService.reserveEffect(
        input.type === "EMAIL"
          ? {
              id: input.id,
              caseId: input.caseId,
              type: input.type,
              purpose: input.purpose,
              payload: {
                type: "EMAIL",
                to: input.to,
                subject: input.subject,
                html: input.html,
              },
            }
          : {
              id: input.id,
              caseId: input.caseId,
              type: input.type,
              purpose: input.purpose,
              payload: {
                type: "PERFORMANCE_ENTRY",
                contractorId: input.contractorId,
                scoreDelta: input.scoreDelta,
                reason: input.reason,
              },
            }
      );
      return c.json({ effect }, 201);
    } catch (error) {
      if (error instanceof alertService.ImmutableEffectConflictError) {
        return c.json(
          {
            error: {
              code: "IMMUTABLE_EFFECT_CONFLICT",
              message: error.message,
              retryable: false,
            },
          },
          409
        );
      }
      throw error;
    }
  })
  .get(
    "/case/:caseId",
    validator("param", z.object({ caseId: z.uuid() })),
    async (c) =>
      c.json({
        effects: await alertService.listEffectSummaries(
          c.req.valid("param").caseId
        ),
      })
  )
  .get("/:id", validator("param", effectIdSchema), async (c) => {
    const effect = await alertService.getEffect(c.req.valid("param").id);
    return effect
      ? c.json({ effect: alertService.toEffectSummary(effect) })
      : c.json({ error: "Effect not found" }, 404);
  })
  .post("/:id/begin", validator("param", effectIdSchema), async (c) => {
    const effect = await alertService.beginEffect(c.req.valid("param").id);
    return effect
      ? c.json({ effect: alertService.toEffectSummary(effect) })
      : c.json({ error: "Effect not found" }, 404);
  })
  .post("/:id/succeed", validator("param", effectIdSchema), async (c) => {
    const body = z
      .object({ providerId: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const effect = await alertService.succeedEffect(
      c.req.valid("param").id,
      body.providerId
    );
    return effect
      ? c.json({ effect: alertService.toEffectSummary(effect) })
      : c.json({ error: "Effect not found" }, 404);
  })
  .post(
    "/:id/fail",
    validator("param", effectIdSchema),
    validator("json", failEffectSchema),
    async (c) => {
      const body = c.req.valid("json");
      const effect = await alertService.failEffect(
        c.req.valid("param").id,
        body.error,
        body.nextRetryAt
      );
      return effect
        ? c.json({ effect: alertService.toEffectSummary(effect) })
        : c.json({ error: "Effect not found" }, 404);
    }
  )
  .post("/:id/unknown", validator("param", effectIdSchema), async (c) => {
    try {
      const effect = await alertService.markEffectUnknown(
        c.req.valid("param").id
      );
      return effect
        ? c.json({ effect: alertService.toEffectSummary(effect) })
        : c.json({ error: "Effect not found" }, 404);
    } catch (error) {
      if (error instanceof alertService.EffectUnknownNotEligibleError) {
        return c.json(
          {
            error: {
              code: "EFFECT_UNKNOWN_NOT_ELIGIBLE",
              message: error.message,
              retryable: false,
            },
          },
          409
        );
      }
      throw error;
    }
  })
  .post("/:id/retry", validator("param", effectIdSchema), async (c) => {
    const body = z
      .object({ acknowledgeDuplicateRisk: z.boolean().default(false) })
      .parse(await c.req.json().catch(() => ({})));
    const result = await alertService.retryEffect(
      c.req.valid("param").id,
      body.acknowledgeDuplicateRisk
    );
    if (result.kind === "NOT_FOUND")
      return c.json({ error: "Effect not found" }, 404);
    if (result.kind === "ACK_REQUIRED")
      return c.json({ error: "Duplicate-risk acknowledgement required" }, 409);
    if (result.kind === "NOT_REPAIRABLE")
      return c.json({ error: "Effect is not repairable" }, 409);
    return c.json({ effect: alertService.toEffectSummary(result.effect) });
  })
  .post("/:id/waive", validator("param", effectIdSchema), async (c) => {
    const body = z
      .object({
        actorId: z.uuid(),
        reason: z.string().trim().min(1).max(1_000),
      })
      .parse(await c.req.json());
    const effect = await alertService.waiveEffect({
      id: c.req.valid("param").id,
      ...body,
    });
    return effect
      ? c.json({ effect: alertService.toEffectSummary(effect) })
      : c.json({ error: "Effect not found" }, 404);
  })
  .post(
    "/:id/dispatch-email",
    validator("param", effectIdSchema),
    validator("json", failEffectSchema.pick({ nextRetryAt: true })),
    async (c) => {
      const id = c.req.valid("param").id;
      const begun = await alertService.beginEffect(id);
      if (!begun) return c.json({ error: "Effect not found" }, 404);
      if (begun.status !== "PENDING") {
        return c.json({ effect: alertService.toEffectSummary(begun) });
      }
      const stored = await alertService.getEffect(id);
      if (!stored || stored.payload.type !== "EMAIL")
        return c.json({ error: "Effect is not an email" }, 409);
      try {
        const data = await sendEmail({
          ...stored.payload,
          idempotencyKey: stored.providerIdempotencyKey,
        });
        const effect = await alertService.succeedEffect(id, data?.id);
        return c.json({
          effect: effect && alertService.toEffectSummary(effect),
        });
      } catch (error) {
        const effect = await alertService.failEffect(
          id,
          error instanceof Error ? error.message : String(error),
          c.req.valid("json").nextRetryAt
        );
        return c.json({
          effect: effect && alertService.toEffectSummary(effect),
        });
      }
    }
  );

app.route("/internal/effects", internalEffectsRouter);

startAlertQueueWorker();

export { app };

export type AlertAtomType = typeof alertRoutes;

export default {
  port: env.PORT,
  fetch: app.fetch,
};

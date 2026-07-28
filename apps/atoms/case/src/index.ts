import { Scalar } from "@scalar/hono-api-reference";
import {
  CancelCaseTransitionInputSchema,
  CompleteCaseTransitionInputSchema,
  CreateCaseActivityInputSchema,
  MarkCaseAppointmentReplacedInputSchema,
  MarkCaseBreachedInputSchema,
  MarkCaseInProgressInputSchema,
  MarkCaseNoAccessInputSchema,
  RecordAllocationAcceptanceInputSchema,
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
import {
  describeRoute,
  openAPIRouteHandler,
  resolver,
  validator,
} from "hono-openapi";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import { insertCaseSchema, selectCaseSchema } from "./database/schema";
import { env } from "./env";
import * as caseService from "./service";
import {
  getCaseSchema,
  markCaseAssignedSchema,
  officerAttentionListSchema,
  raiseOfficerAttentionSchema,
  updateCaseStatusSchema,
} from "./validation-schemas";

const app = new Hono();

function publicCase<
  T extends {
    completionOperationId?: unknown;
    completionReport?: unknown;
    completionProofItemIds?: unknown;
  },
>(record: T) {
  const {
    completionOperationId: _completionOperationId,
    completionReport: _completionReport,
    completionProofItemIds: _completionProofItemIds,
    ...value
  } = record;
  return value;
}

initSentry({ serviceName: "case-atom" });

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
    "[case atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

// custom logging middleware
app.use("*", honoLogger());

const casesRouter = new Hono()
  .get(
    "/",
    describeRoute({
      description: "Retrieve all cases",
      responses: {
        200: {
          description: "List of cases",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: z.array(selectCaseSchema) })),
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const caseRows = await caseService.getAllCases();
      logger.info(
        { route: "/api/cases", rowCount: caseRows.length },
        "Retrieved all cases"
      );
      return c.json({ cases: caseRows.map(publicCase) }, 200);
    }
  )
  .get(
    "/officer-attention",
    describeRoute({ description: "List Officer Attention records" }),
    validator("query", officerAttentionListSchema),
    async (c) => {
      const query = c.req.valid("query");
      const attentions = await caseService.listOfficerAttention(query);
      return c.json({ attentions }, 200);
    }
  )
  .get(
    "/:id",
    describeRoute({
      description: "Get a case by its ID",
      responses: {
        200: {
          description: "Case found",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: z.array(selectCaseSchema) })),
            },
          },
        },
        400: { description: "Invalid UUID provided" },
      },
    }),
    validator("param", z.object({ id: getCaseSchema })),
    async (c) => {
      const { id } = c.req.valid("param");
      const caseRows = await caseService.getCaseById(id);

      logger.info(
        { route: "/api/cases/:id", caseId: id, found: caseRows.length > 0 },
        "Case lookup executed"
      );
      return c.json({ cases: caseRows.map(publicCase) }, 200);
    }
  )
  .put(
    "/update-case-status",
    describeRoute({
      description: "Update the status of a case",
      responses: {
        200: {
          description: "Status updated",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: selectCaseSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", updateCaseStatusSchema),
    async (c) => {
      const body = c.req.valid("json");
      const updatedCase = await caseService.updateCaseStatus(
        body.id,
        body.status
      );

      logger.info(
        {
          route: "/api/cases/update-case-status",
          caseId: body.id,
          status: body.status,
        },
        "Case status updated"
      );
      return c.json(
        { cases: updatedCase ? publicCase(updatedCase) : null },
        200
      );
    }
  )
  .post(
    "/new-case",
    describeRoute({
      description: "Create a new case ticket",
      responses: {
        201: {
          description: "Case created",
          content: {
            "application/json": {
              schema: resolver(z.object({ cases: selectCaseSchema })),
            },
          },
        },
        400: { description: "Validation failed" },
      },
    }),
    validator("json", insertCaseSchema),
    async (c) => {
      const body = c.req.valid("json");
      const newCase = await caseService.createCase(body);

      logger.info(
        {
          route: "/api/cases/new-case",
          caseId: newCase.id,
          category: body.category,
        },
        "New case created successfully"
      );
      return c.json({ cases: publicCase(newCase) }, 201);
    }
  );

const internalCasesRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get("/:id", validator("param", z.object({ id: z.uuid() })), async (c) => {
    const { id } = c.req.valid("param");
    const [caseRecord] = await caseService.getCaseById(id);
    if (!caseRecord) return c.json({ error: "Case not found" }, 404);
    return c.json({ case: caseRecord }, 200);
  })
  .post("/", validator("json", CreateCaseActivityInputSchema), async (c) => {
    const body = c.req.valid("json");
    const newCase = await caseService.createCaseForOperation(body);

    return c.json({ case: newCase }, 201);
  })
  .post(
    "/:id/officer-attention",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", raiseOfficerAttentionSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const attention = await caseService.raiseOfficerAttention({
        caseId: id,
        ...c.req.valid("json"),
      });
      return c.json({ attention }, 201);
    }
  )
  .post(
    "/:id/assign",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", markCaseAssignedSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await caseService.markCaseAssignedForOperation({
        caseId: id,
        ...body,
      });

      return c.json(result, 200);
    }
  )
  .post(
    "/:id/allocation-acceptance",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", RecordAllocationAcceptanceInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const history = await caseService.recordAllocationAcceptance(body);
      return c.json({ history }, 201);
    }
  )
  .post(
    "/:id/allocation-breach",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", MarkCaseBreachedInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result = await caseService.markCaseBreachedForOperation(body);
      return c.json(result, 200);
    }
  )
  .post(
    "/:id/start-work",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", MarkCaseInProgressInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result = await caseService.markCaseInProgressForOperation(body);
      if (result.outcome === "CASE_TERMINAL") return c.json(result, 409);
      return c.json(result, 201);
    }
  )
  .post(
    "/:id/no-access",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", MarkCaseNoAccessInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result = await caseService.markCaseNoAccessForOperation(body);
      if (result.outcome === "CASE_TERMINAL") return c.json(result, 409);
      return c.json(result, 201);
    }
  )
  .post(
    "/:id/appointment-replaced",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", MarkCaseAppointmentReplacedInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result =
        await caseService.markCaseAppointmentReplacedForOperation(body);
      if (result.outcome === "CASE_TERMINAL") return c.json(result, 409);
      return c.json(result, 201);
    }
  )
  .post(
    "/:id/cancel",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", CancelCaseTransitionInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result = await caseService.cancelCaseForOperation(body);
      if (result.outcome === "NOT_CANCELLABLE") return c.json(result, 409);
      return c.json(result, 201);
    }
  )
  .post(
    "/:id/complete",
    validator("param", z.object({ id: z.uuid() })),
    validator("json", CompleteCaseTransitionInputSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.caseId !== id) return c.json({ error: "Case ID mismatch" }, 400);
      const result = await caseService.completeCaseForOperation(body);
      if (
        result.outcome === "CASE_TERMINAL" ||
        result.outcome === "NOT_IN_PROGRESS"
      ) {
        return c.json(result, 409);
      }
      return c.json(result, 201);
    }
  );

const caseAtomRoutes = app
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
  .route("/api/cases", casesRouter)
  .route("/internal/cases", internalCasesRouter)
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Case Atom API",
          version: "1.0.0",
          description: "Municipal case management backplane APIs",
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
export type CaseAtomType = typeof caseAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

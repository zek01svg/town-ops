import { Scalar } from "@scalar/hono-api-reference";
import {
  logger,
  honoLogger,
  corsOrigins,
  initSentry,
  captureHonoException,
} from "@townops/shared-ts";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import { env } from "./env";
import * as proofService from "./service";
import { storage } from "./storage";
import { getProofSchema, uploadProofSchema } from "./validation-schemas";

const app = new Hono();

initSentry({ serviceName: "proof-atom" });

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
    "[proof atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());

const proofRouter = new Hono()
  .get(
    "/:case_id",
    describeRoute({ description: "Get proof for a case" }),
    validator("param", getProofSchema),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const rows = await proofService.getProofByCaseId(case_id);
      return c.json({ proof: rows }, 200);
    }
  )
  .post(
    "",
    describeRoute({
      description: "Upload proof image with form-data and create record",
    }),
    validator("form", uploadProofSchema),
    async (c) => {
      const { file, caseId, uploaderId, type, remarks } = c.req.valid("form");

      if (!file || !(file instanceof File)) {
        return c.json(
          { error: "Missing or invalid file in upload trigger" },
          400
        );
      }

      const filePath = `${caseId}/${Date.now()}_proof_item`;

      // Upload to S3-compatible storage
      // storage.write throws on failure; app.onError returns 500.
      await storage.write(filePath, file, {
        type: file.type || "application/octet-stream",
      });

      // S3_PUBLIC_URL is the base under which objects are publicly served:
      // MinIO path-style includes the bucket (…:9000/proofs), R2's public
      // domain is already bucket-scoped. Keeping the bucket in config (not
      // here) makes the MinIO→R2 swap config-only.
      const mediaUrl = `${env.S3_PUBLIC_URL}/${filePath}`;

      // 2. Create record in database using service
      const proof = await proofService.storeSingleProofItem({
        caseId,
        uploaderId,
        mediaUrl,
        type: type,
        remarks,
      });

      return c.json({ proof }, 201);
    }
  )
  .post(
    "/batch",
    describeRoute({
      description: "Store multiple proof items (JSON record only)",
    }),
    validator(
      "json",
      z.object({
        caseId: z.string().uuid(),
        uploaderId: z.string().uuid(),
        items: z.array(
          z.object({
            mediaUrl: z.string().url(),
            type: z.enum(["before", "after", "signature"]),
            remarks: z.string().optional(),
          })
        ),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const rows = await proofService.storeProofItems(
        body.caseId,
        body.uploaderId,
        body.items
      );
      return c.json({ proof: rows }, 201);
    }
  );

const proofAtomRoutes = app
  .get(
    "/health",
    describeRoute({ description: "Service health check" }),
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .route("/api/proof", proofRouter)
  .get(
    "/openapi",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Proof Atom API",
          version: "1.0.0",
          description: "Standalone specs",
        },
        servers: [
          { url: `http://localhost:${env.PORT}`, description: "Local Service" },
        ],
      },
    })
  )
  .get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

export { app };
export type ProofAtomType = typeof proofAtomRoutes;
export default {
  port: env.PORT,
  fetch: app.fetch,
};

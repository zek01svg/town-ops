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
import { supabase } from "./supabase";
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

      // 1. Upload file to Supabase Storage
      const { error } = await supabase.storage
        .from(env.SUPABASE_BUCKET)
        .upload(filePath, file, {
          contentType: file.type || "application/octet-stream",
        });

      if (error) {
        logger.error({ error: error.message }, "Supabase upload failed");
        return c.json({ error: error.message }, 500);
      }

      const { data: publicUrlData } = supabase.storage
        .from(env.SUPABASE_BUCKET)
        .getPublicUrl(filePath);

      const mediaUrl = publicUrlData.publicUrl;

      // 2. Create record in database using service
      const proof = await proofService.storeSingleProofItem({
        caseId,
        uploaderId,
        mediaUrl,
        type: type as any,
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

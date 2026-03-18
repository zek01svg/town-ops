import { Scalar } from "@scalar/hono-api-reference";
import { logger, honoLogger } from "@townops/shared-observability-ts";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { jwk } from "hono/jwk";

import db from "./database/db";
import { proofItems } from "./database/schema";
import { env } from "./env";
import { supabase } from "./supabase";
import { getProofSchema, uploadProofSchema } from "./validation-schemas";
const app = new Hono();

app.onError((err, c) => {
  logger.error(
    { error: err.message, stack: err.stack, route: c.req.path },
    "[proof atom] internal server error"
  );
  return c.json({ error: err.message }, 500);
});

app.use("*", honoLogger());
app.use("/api/*", jwk({ jwks_uri: env.JWKS_URI, alg: ["RS256"] }));

app
  .get(
    "/health",
    describeRoute({ description: "Service health check" }),
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .get(
    "/api/proof/:case_id",
    describeRoute({ description: "Get proof for a case" }),
    validator("param", getProofSchema),
    async (c) => {
      const { case_id } = c.req.valid("param");
      const rows = await db
        .select()
        .from(proofItems)
        .where(eq(proofItems.caseId, case_id));
      return c.json({ proof: rows }, 200);
    }
  )
  .post(
    "/api/proof",
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
      const { data: _data, error } = await supabase.storage
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

      // 2. Create record in database with the image URL
      const rows = await db
        .insert(proofItems)
        .values({
          caseId,
          uploaderId,
          mediaUrl,
          type: type as any,
          remarks,
        })
        .returning();

      return c.json({ proof: rows[0] }, 201);
    }
  );

app.get(
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
);

app.get("/scalar", Scalar({ url: "/openapi", theme: "deepSpace" }));

export { app };

export default {
  port: env.PORT,
  fetch: app.fetch,
};

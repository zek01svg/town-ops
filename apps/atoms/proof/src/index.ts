import { createHash } from "node:crypto";

import { Scalar } from "@scalar/hono-api-reference";
import { ProofItemDtoSchema } from "@townops/orchestration-contract";
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
import { describeRoute, openAPIRouteHandler, validator } from "hono-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod/v4";

import { env } from "./env";
import * as proofService from "./service";
import { storage } from "./storage";
import {
  getProofSchema,
  internalProofUploadSchema,
  internalProofLookupSchema,
  internalProofListSchema,
  uploadProofSchema,
} from "./validation-schemas";

const MAX_PROOF_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PROOF_BODY_BYTES = MAX_PROOF_FILE_BYTES + 64 * 1024;

function isSupportedProofImage(file: File, bytes: Uint8Array) {
  switch (file.type.toLowerCase()) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/webp":
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}

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

function proofDto(proof: {
  id: string;
  caseId: string;
  contractorId: string | null;
  mediaUrl: string;
  type: "before" | "after" | "signature";
  remarks: string | null;
  checksum: string | null;
  readyAt: string | null;
  createdAt: string | null;
}) {
  return ProofItemDtoSchema.parse({
    ...proof,
    type: proof.type.toUpperCase(),
    ready: proof.readyAt !== null,
  });
}

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

const internalProofRouter = new Hono()
  .use("*", workerAuth(env.WORKER_SERVICE_TOKEN))
  .get(
    "/proof-items/:caseId",
    validator("param", z.object({ caseId: z.uuid() })),
    validator("query", internalProofListSchema),
    async (c) => {
      const { caseId } = c.req.valid("param");
      const { contractorId } = c.req.valid("query");
      const proof = await proofService.listReadyProofItems({
        caseId,
        contractorId,
      });
      return c.json({ proof: proof.map(proofDto) }, 200);
    }
  )
  .get(
    "/proof-items/:proofItemId/resolve",
    validator("param", z.object({ proofItemId: z.uuid() })),
    validator("query", internalProofLookupSchema),
    async (c) => {
      const { proofItemId } = c.req.valid("param");
      const { caseId, contractorId } = c.req.valid("query");
      const proof = await proofService.resolveReadyProofItem({
        proofItemId,
        caseId,
        contractorId,
      });
      if (!proof) return c.json({ error: "Proof item not found" }, 404);
      return c.json({ proof: proofDto(proof) }, 200);
    }
  )
  .post(
    "/proof-items",
    bodyLimit({
      maxSize: MAX_PROOF_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "PROOF_FILE_TOO_LARGE",
              message: "Proof uploads must be 10 MiB or smaller",
              retryable: false,
            },
          },
          413
        ),
    }),
    validator("form", internalProofUploadSchema),
    async (c) => {
      const idempotencyKey = z
        .uuid()
        .safeParse(c.req.header("Idempotency-Key"));
      if (!idempotencyKey.success) {
        return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
      }
      const { file, proofItemId, caseId, contractorId, type, remarks } =
        c.req.valid("form");
      if (!(file instanceof File)) {
        return c.json({ error: { code: "VALIDATION_ERROR" } }, 400);
      }
      if (file.size > MAX_PROOF_FILE_BYTES) {
        return c.json(
          {
            error: {
              code: "PROOF_FILE_TOO_LARGE",
              message: "Proof uploads must be 10 MiB or smaller",
              retryable: false,
            },
          },
          413
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isSupportedProofImage(file, bytes)) {
        return c.json(
          {
            error: {
              code: "UNSUPPORTED_PROOF_IMAGE",
              message: "Proof uploads must be JPEG, PNG, or WebP images",
              retryable: false,
            },
          },
          415
        );
      }
      if (idempotencyKey.data !== proofItemId) {
        return c.json({ error: { code: "IDEMPOTENCY_KEY_REUSED" } }, 409);
      }

      const checksum = createHash("sha256").update(bytes).digest("hex");
      const payloadHash = createHash("sha256")
        .update(
          JSON.stringify({
            caseId,
            contractorId,
            type,
            remarks: remarks ?? null,
          })
        )
        .digest("hex");
      const claim = await proofService.claimProofUpload({
        proofItemId,
        caseId,
        contractorId,
        type:
          type === "BEFORE"
            ? "before"
            : type === "AFTER"
              ? "after"
              : "signature",
        remarks,
        payloadHash,
        checksum,
      });
      if (claim.kind === "IDEMPOTENCY_KEY_REUSED") {
        return c.json({ error: { code: claim.kind } }, 409);
      }
      if (claim.kind === "PROOF_CONTENT_MISMATCH") {
        return c.json({ error: { code: claim.kind } }, 409);
      }
      if (claim.proof.readyAt) {
        return c.json({ proof: proofDto(claim.proof) }, 200);
      }

      const filePath = `${caseId}/${proofItemId}`;
      await storage.write(filePath, file, {
        type: file.type || "application/octet-stream",
      });
      const proof = await proofService.markProofReady({
        proofItemId,
        mediaUrl: `${env.S3_PUBLIC_URL}/${filePath}`,
      });
      return c.json({ proof: proofDto(proof) }, 201);
    }
  );

const proofAtomRoutes = app
  .get(
    "/health",
    describeRoute({ description: "Service health check" }),
    async (c: Context) => c.json({ status: "healthy" }, 200)
  )
  .route("/api/proof", proofRouter)
  .route("/internal", internalProofRouter)
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

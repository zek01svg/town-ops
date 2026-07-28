import type { Context, Next } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../../src/index";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5007";
  process.env.JWKS_URI = "http://localhost:5001/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_URL = "http://localhost:9000/proofs";
  process.env.S3_ACCESS_KEY_ID = "test";
  process.env.S3_SECRET_ACCESS_KEY = "test";
  process.env.S3_BUCKET = "proofs";
  process.env.S3_REGION = "us-east-1";
  process.env.WORKER_SERVICE_TOKEN = "test-worker-token-000000000000000000";

  return {
    claimProofUpload: vi.fn(),
    markProofReady: vi.fn(),
    storageWrite: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@townops/shared-ts", () => ({
  captureHonoException: vi.fn(),
  corsOrigins: () => undefined,
  honoLogger: () => async (_c: Context, next: Next) => next(),
  initSentry: vi.fn(),
  logger: { error: vi.fn() },
  workerAuth: (token: string) => async (c: Context, next: Next) =>
    c.req.header("Authorization") === `Bearer ${token}`
      ? next()
      : c.json({ error: { code: "UNAUTHORIZED" } }, 401),
}));

vi.mock("../../src/service", () => ({
  claimProofUpload: mocks.claimProofUpload,
  getProofByCaseId: vi.fn(),
  listReadyProofItems: vi.fn(),
  markProofReady: mocks.markProofReady,
  resolveReadyProofItem: vi.fn(),
  storeProofItems: vi.fn(),
  storeSingleProofItem: vi.fn(),
}));

vi.mock("../../src/storage", () => ({
  storage: { write: mocks.storageWrite },
}));

const caseId = "123e4567-e89b-12d3-a456-426614174001";
const contractorId = "123e4567-e89b-12d3-a456-426614174002";
const workerToken = "test-worker-token-000000000000000000";

const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const pngMagic = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const webpMagic = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const maxProofBodyBytes = 10 * 1024 * 1024 + 64 * 1024;

function proofFile(bytes: Uint8Array, type: string, name: string) {
  return new File([bytes], name, { type });
}

function uploadForm(file: File, proofItemId: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("proofItemId", proofItemId);
  form.append("caseId", caseId);
  form.append("contractorId", contractorId);
  form.append("type", "BEFORE");
  return form;
}

async function internalUpload(
  file: File,
  proofItemId = "123e4567-e89b-12d3-a456-426614174003",
  headers: HeadersInit = {}
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Authorization", `Bearer ${workerToken}`);
  requestHeaders.set("Idempotency-Key", proofItemId);
  return app.request("/internal/proof-items", {
    method: "POST",
    headers: requestHeaders,
    body: uploadForm(file, proofItemId),
  });
}

function readyProof(proofItemId: string) {
  return {
    id: proofItemId,
    caseId,
    contractorId,
    mediaUrl: `http://localhost:9000/proofs/${caseId}/${proofItemId}`,
    type: "before" as const,
    remarks: null,
    checksum: "a".repeat(64),
    readyAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("internal proof upload validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimProofUpload.mockImplementation(async (input) => ({
      kind: "CLAIMED",
      proof: { ...readyProof(input.proofItemId), readyAt: null },
    }));
    mocks.markProofReady.mockImplementation(async (input) =>
      readyProof(input.proofItemId)
    );
  });

  it.each([
    ["JPEG", "image/jpeg", jpegMagic, "proof.jpg"],
    ["PNG", "image/png", pngMagic, "proof.png"],
    ["WebP", "image/webp", webpMagic, "proof.webp"],
  ])(
    "accepts a supported %s file and only then claims and stores it",
    async (_name, mime, bytes, name) => {
      const proofItemId = crypto.randomUUID();
      const response = await internalUpload(
        proofFile(bytes, mime, name),
        proofItemId
      );

      expect(response.status).toBe(201);
      expect(mocks.claimProofUpload).toHaveBeenCalledTimes(1);
      expect(mocks.storageWrite).toHaveBeenCalledWith(
        `${caseId}/${proofItemId}`,
        expect.any(File),
        { type: mime }
      );
      expect(mocks.markProofReady).toHaveBeenCalledWith({
        proofItemId,
        mediaUrl: `http://localhost:9000/proofs/${caseId}/${proofItemId}`,
      });
    }
  );

  it.each([
    ["an unsupported MIME type", "image/gif", pngMagic, "proof.gif"],
    ["a PNG MIME type with JPEG bytes", "image/png", jpegMagic, "proof.png"],
  ])(
    "rejects %s before claiming or storing",
    async (_name, mime, bytes, name) => {
      const response = await internalUpload(proofFile(bytes, mime, name));

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        error: { code: "UNSUPPORTED_PROOF_IMAGE", retryable: false },
      });
      expect(mocks.claimProofUpload).not.toHaveBeenCalled();
      expect(mocks.storageWrite).not.toHaveBeenCalled();
    }
  );

  it("rejects an oversized Content-Length before parsing, claiming, or storing", async () => {
    const response = await internalUpload(
      proofFile(pngMagic, "image/png", "proof.png"),
      crypto.randomUUID(),
      { "Content-Length": String(10 * 1024 * 1024 + 64 * 1024 + 1) }
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PROOF_FILE_TOO_LARGE", retryable: false },
    });
    expect(mocks.claimProofUpload).not.toHaveBeenCalled();
    expect(mocks.storageWrite).not.toHaveBeenCalled();
  });

  it("rejects an oversized chunked multipart body without Content-Length before claiming or storing", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const chunks = Math.ceil((maxProofBodyBytes + 1) / chunk.byteLength);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === chunks) {
          controller.close();
          return;
        }
        emitted++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://proof-atom/internal/proof-items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerToken}`,
        "Content-Type": "multipart/form-data; boundary=unused",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body,
      duplex: "half",
    });

    const response = await app.fetch(request);

    expect(request.headers.has("Content-Length")).toBe(false);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PROOF_FILE_TOO_LARGE", retryable: false },
    });
    expect(mocks.claimProofUpload).not.toHaveBeenCalled();
    expect(mocks.storageWrite).not.toHaveBeenCalled();
  });
});

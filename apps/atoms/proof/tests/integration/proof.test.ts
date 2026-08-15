import { randomUUID } from "node:crypto";

import type { Context, Next } from "hono";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let db: (typeof import("../../src/database/db"))["default"];
let proofItems: (typeof import("../../src/database/schema"))["proofItems"];
let app: (typeof import("../../src/index"))["app"];

// 1. Mock Custom Middleware
vi.mock("hono/jwk", () => ({
  jwk: () => (c: Context, next: Next) => next(),
}));

// 2. Mock storage interface (Bun S3 client)
const mockWrite = vi.fn().mockResolvedValue(undefined);
// presign is SYNCHRONOUS in Bun's S3Client (returns a string, not a Promise),
// so the mock must be too -- proofDto() calls it inline when serializing a
// proof whose mediaUrl holds an object path.
const mockPresign = vi.fn((key: string) => `https://signed.test/${key}?sig=x`);

vi.mock("../../src/storage", () => ({
  storage: { write: mockWrite, presign: mockPresign },
}));

describe("Proof Atom Integration Tests", () => {
  beforeAll(async () => {
    console.log(
      "TEST RUNNER process.env.DATABASE_URL:",
      process.env.DATABASE_URL
    );

    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    proofItems = schemaModule.proofItems;
    app = appModule.app;
  });

  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(proofItems);
    vi.clearAllMocks();
  });

  const VALID_CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
  const VALID_UPLOADER_ID = "123e4567-e89b-12d3-a456-426614174002";
  const WORKER_TOKEN = "test-worker-token-000000000000000000";
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const DIFFERENT_PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
  ]);

  function internalForm(input: {
    proofItemId: string;
    type?: "BEFORE" | "AFTER";
    bytes?: Uint8Array;
  }) {
    const form = new FormData();
    form.append(
      "file",
      new File([input.bytes ?? PNG_BYTES], "proof.png", {
        type: "image/png",
      })
    );
    form.append("proofItemId", input.proofItemId);
    form.append("caseId", VALID_CASE_ID);
    form.append("contractorId", VALID_UPLOADER_ID);
    form.append("type", input.type ?? "BEFORE");
    return form;
  }

  function internalUpload(input: {
    proofItemId: string;
    type?: "BEFORE" | "AFTER";
    bytes?: string;
    idempotencyKey?: string;
  }) {
    return app.request("/internal/proof-items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_TOKEN}`,
        "Idempotency-Key": input.idempotencyKey ?? input.proofItemId,
      },
      body: internalForm(input),
    });
  }

  function internalList(contractorId = VALID_UPLOADER_ID) {
    return app.request(
      `/internal/proof-items/${VALID_CASE_ID}?contractorId=${contractorId}`,
      { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } }
    );
  }

  function internalListAll() {
    return app.request(`/internal/proof-items/${VALID_CASE_ID}`, {
      headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
    });
  }

  function internalResolve(
    proofItemId: string,
    contractorId = VALID_UPLOADER_ID
  ) {
    return app.request(
      `/internal/proof-items/${proofItemId}/resolve?caseId=${VALID_CASE_ID}&contractorId=${contractorId}`,
      { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } }
    );
  }

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("internal immutable proof uploads (PRS-147)", () => {
    it("replays the same key, metadata, and bytes without rewriting the ready object", async () => {
      const proofItemId = randomUUID();

      const first = await internalUpload({ proofItemId });
      const replay = await internalUpload({ proofItemId });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        proof: {
          id: proofItemId,
          caseId: VALID_CASE_ID,
          contractorId: VALID_UPLOADER_ID,
          type: "BEFORE",
          ready: true,
          // The DTO serves a PRESIGNED url, while the row stores only the
          // object path (asserted on mockWrite below). Keeping these two
          // assertions different is the point: if the handler ever goes back
          // to persisting a public URL, this pair fails.
          mediaUrl: `https://signed.test/${VALID_CASE_ID}/${proofItemId}?sig=x`,
        },
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith(
        `${VALID_CASE_ID}/${proofItemId}`,
        expect.any(File),
        { type: "image/png" }
      );
    });

    it("binds the proof item identity to the idempotency key before any storage write", async () => {
      const proofItemId = randomUUID();
      const response = await internalUpload({
        proofItemId,
        idempotencyKey: randomUUID(),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "IDEMPOTENCY_KEY_REUSED" },
      });
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it("rejects metadata or checksum changes for an existing key without overwriting", async () => {
      const proofItemId = randomUUID();
      expect((await internalUpload({ proofItemId })).status).toBe(201);

      const metadataReuse = await internalUpload({
        proofItemId,
        type: "AFTER",
      });
      const contentMismatch = await internalUpload({
        proofItemId,
        bytes: DIFFERENT_PNG_BYTES,
      });

      expect(metadataReuse.status).toBe(409);
      expect(await metadataReuse.json()).toEqual({
        error: { code: "IDEMPOTENCY_KEY_REUSED" },
      });
      expect(contentMismatch.status).toBe(409);
      expect(await contentMismatch.json()).toEqual({
        error: { code: "PROOF_CONTENT_MISMATCH" },
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
    });

    it("keeps one immutable row when simultaneous identical retries race", async () => {
      const proofItemId = randomUUID();
      const responses = await Promise.all([
        internalUpload({ proofItemId }),
        internalUpload({ proofItemId }),
      ]);

      expect(responses.map((response) => response.status)).toEqual(
        expect.arrayContaining([201, expect.any(Number)])
      );
      expect(
        responses.every(
          (response) => response.status === 200 || response.status === 201
        )
      ).toBe(true);
      const listed = await internalList();
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        proof: [expect.objectContaining({ id: proofItemId })],
      });
    });

    it("recovers an interrupted, not-ready upload with the same immutable key", async () => {
      const proofItemId = randomUUID();
      mockWrite.mockRejectedValueOnce(new Error("storage interrupted"));

      const interrupted = await internalUpload({ proofItemId });
      expect(interrupted.status).toBe(500);
      const beforeRecovery = await internalList();
      expect(beforeRecovery.status).toBe(200);
      expect(await beforeRecovery.json()).toEqual({ proof: [] });

      const recovered = await internalUpload({ proofItemId });
      expect(recovered.status).toBe(201);
      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect((await internalResolve(proofItemId)).status).toBe(200);
    });

    it("lists and resolves only ready contractor-owned Proof Items", async () => {
      const ownedId = randomUUID();
      const foreignId = randomUUID();
      const legacyId = randomUUID();
      const unreadyId = randomUUID();
      const foreignContractorId = randomUUID();
      expect((await internalUpload({ proofItemId: ownedId })).status).toBe(201);
      await db.insert(proofItems).values([
        {
          id: foreignId,
          caseId: VALID_CASE_ID,
          uploaderId: foreignContractorId,
          contractorId: foreignContractorId,
          operationId: randomUUID(),
          payloadHash: "a".repeat(64),
          mediaUrl: "https://proof.example/foreign",
          type: "before",
          checksum: "a".repeat(64),
          readyAt: "2030-01-01T00:00:00.000Z",
        },
        {
          id: legacyId,
          caseId: VALID_CASE_ID,
          uploaderId: VALID_UPLOADER_ID,
          contractorId: null,
          mediaUrl: "https://proof.example/legacy",
          type: "before",
          readyAt: "2030-01-01T00:00:00.000Z",
        },
        {
          id: unreadyId,
          caseId: VALID_CASE_ID,
          uploaderId: VALID_UPLOADER_ID,
          contractorId: VALID_UPLOADER_ID,
          operationId: randomUUID(),
          payloadHash: "b".repeat(64),
          mediaUrl: "",
          type: "after",
          checksum: "b".repeat(64),
          readyAt: null,
        },
      ]);

      const listed = await internalList();
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        proof: [expect.objectContaining({ id: ownedId })],
      });
      expect((await internalResolve(ownedId)).status).toBe(200);
      expect((await internalResolve(foreignId)).status).toBe(404);
      expect((await internalResolve(legacyId)).status).toBe(404);
      expect((await internalResolve(unreadyId)).status).toBe(404);
      expect((await internalResolve(randomUUID())).status).toBe(404);
    });

    it("returns ready Proof Items from every contractor when contractorId is omitted, and only one contractor's when supplied (PRS-151)", async () => {
      const ownedId = randomUUID();
      const otherContractorId = randomUUID();
      const otherReadyId = randomUUID();
      expect((await internalUpload({ proofItemId: ownedId })).status).toBe(201);
      await db.insert(proofItems).values({
        id: otherReadyId,
        caseId: VALID_CASE_ID,
        uploaderId: otherContractorId,
        contractorId: otherContractorId,
        operationId: randomUUID(),
        payloadHash: "c".repeat(64),
        mediaUrl: "https://proof.example/other",
        type: "before",
        checksum: "c".repeat(64),
        readyAt: "2030-01-01T00:00:00.000Z",
      });

      const unfiltered = await internalListAll();
      expect(unfiltered.status).toBe(200);
      const unfilteredIds = (await unfiltered.json()).proof
        .map((item: { id: string }) => item.id)
        .toSorted();
      expect(unfilteredIds).toEqual([ownedId, otherReadyId].toSorted());

      const filtered = await internalList();
      expect(filtered.status).toBe(200);
      expect(await filtered.json()).toEqual({
        proof: [expect.objectContaining({ id: ownedId })],
      });
    });
  });
});

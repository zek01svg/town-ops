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

vi.mock("../../src/storage", () => ({
  storage: { write: mockWrite },
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

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("Proof CRUD flow with Uploads", () => {
    it("should upload file to storage and index it in Live Container DB", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new File(["hello-proof-content"], "proof_upload.txt", {
          type: "text/plain",
        })
      );
      formData.append("caseId", VALID_CASE_ID);
      formData.append("uploaderId", VALID_UPLOADER_ID);
      formData.append("type", "before");
      formData.append("remarks", "Integration testing remarks");

      const postRes = await app.request("/api/proof", {
        method: "POST",
        body: formData,
      });

      if (postRes.status !== 201) {
        console.error(
          "POST /api/proof FAILED:",
          postRes.status,
          await postRes.clone().text()
        );
      }

      expect(postRes.status).toBe(201);
      const postData = await postRes.json();
      expect(postData.proof.mediaUrl).toMatch(
        new RegExp(
          `^http://localhost:9000/proofs/${VALID_CASE_ID}/\\d+_proof_item$`
        )
      );
      // storage.write is called with the object key (no public base) and the
      // uploaded file, forwarding its content type.
      expect(mockWrite).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${VALID_CASE_ID}/\\d+_proof_item$`)),
        expect.any(File),
        { type: "text/plain" }
      );

      // 2. Retrieve proof for Case ID back from DB Container
      const getRes = await app.request(`/api/proof/${VALID_CASE_ID}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.proof).toHaveLength(1);
      expect(getData.proof[0].mediaUrl).toBe(postData.proof.mediaUrl);
      expect(getData.proof[0].remarks).toBe("Integration testing remarks");
    });

    it("should return 500 when storage upload fails", async () => {
      mockWrite.mockRejectedValueOnce(new Error("storage unavailable"));

      const formData = new FormData();
      formData.append(
        "file",
        new File(["x"], "proof.txt", { type: "text/plain" })
      );
      formData.append("caseId", VALID_CASE_ID);
      formData.append("uploaderId", VALID_UPLOADER_ID);
      formData.append("type", "before");

      const res = await app.request("/api/proof", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "storage unavailable" });

      // Nothing persisted when the upload throws.
      const getRes = await app.request(`/api/proof/${VALID_CASE_ID}`);
      expect((await getRes.json()).proof).toHaveLength(0);
    });
  });
});

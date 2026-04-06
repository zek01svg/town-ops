import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let db: any;
let proofItems: any;
let app: any;

// 1. Mock Custom Middleware
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

// 2. Mock Supabase interface
const mockUpload = vi
  .fn()
  .mockResolvedValue({ data: { path: "uploaded/path" }, error: null });
const mockGetPublicUrl = vi.fn().mockReturnValue({
  data: { publicUrl: "http://supabase.com/uploaded/path" },
});

vi.mock("../../src/supabase", () => ({
  supabase: {
    storage: {
      from: vi.fn().mockReturnValue({
        upload: (...args: any[]) => mockUpload(...args),
        getPublicUrl: (...args: any[]) => mockGetPublicUrl(...args),
      }),
    },
  },
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
    it("should upload file to Supabase and index it in Live Container DB", async () => {
      // 1. Upload proof via Form Data
      mockUpload.mockResolvedValueOnce({
        data: { path: "uploaded/path" },
        error: null,
      });

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
      expect(postData.proof.mediaUrl).toBe("http://supabase.com/uploaded/path");
      expect(mockUpload).toHaveBeenCalled();

      // 2. Retrieve proof for Case ID back from DB Container
      const getRes = await app.request(`/api/proof/${VALID_CASE_ID}`);
      expect(getRes.status).toBe(200);
      const getData = await getRes.json();
      expect(getData.proof).toHaveLength(1);
      expect(getData.proof[0].mediaUrl).toBe(
        "http://supabase.com/uploaded/path"
      );
      expect(getData.proof[0].remarks).toBe("Integration testing remarks");
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// 1. Setup Environment Variables BEFORE importing anything else
const { mockDb } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5005";
  process.env.JWKS_URI = "http://localhost:5001/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.SUPABASE_URL = "http://localhost";
  process.env.SUPABASE_KEY = "test-key";

  const mockReturning = vi.fn();
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockWhere = vi.fn();
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const db = {
    select: mockSelect,
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    _mockWhere: mockWhere,
    _mockReturning: mockReturning,
  };

  return { mockDb: db };
});

// 2. Mock Database and Custom Middlewares
vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

// Mock Supabase Storage interface
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

describe("Proof Atom Endpoints", () => {
  beforeEach(() => {
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

  describe("GET /api/proof/:case_id", () => {
    it("should return 200 and list items", async () => {
      const mockResult = [
        { id: "1", caseId: VALID_CASE_ID, mediaUrl: "http://media.com" },
      ];
      mockDb._mockWhere.mockResolvedValue(mockResult);

      const res = await app.request(`/api/proof/${VALID_CASE_ID}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.proof).toEqual(mockResult);
    });
  });

  describe("POST /api/proof", () => {
    it("should upload file to Supabase stream and return 201 with public url index", async () => {
      // Create a fake File or FormData
      const mockResult = {
        id: "3",
        caseId: VALID_CASE_ID,
        mediaUrl: "http://supabase.com/uploaded/path",
        type: "after",
      };
      mockDb._mockReturning.mockResolvedValue([mockResult]);
      mockUpload.mockResolvedValueOnce({
        data: { path: "uploaded/path" },
        error: null,
      });

      const formData = new FormData();
      // Form parser creates File object inside Hono
      formData.append(
        "file",
        new File(["hello"], "test.txt", { type: "text/plain" })
      );
      formData.append("caseId", VALID_CASE_ID);
      formData.append("uploaderId", VALID_UPLOADER_ID);
      formData.append("type", "after");

      const res = await app.request("/api/proof", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.proof.mediaUrl).toBe("http://supabase.com/uploaded/path");
      expect(mockUpload).toHaveBeenCalled();
    });
  });
});

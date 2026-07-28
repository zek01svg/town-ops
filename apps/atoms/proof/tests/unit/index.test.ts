import type { Context, Next } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { app } from "../../src/index";

// 1. Setup Environment Variables BEFORE importing anything else
const { mockDb, mockWrite } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5005";
  process.env.JWKS_URI = "http://localhost:5001/.well-known/jwks.json";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_PUBLIC_URL = "http://localhost:9000/proofs";
  process.env.S3_ACCESS_KEY_ID = "test";
  process.env.S3_SECRET_ACCESS_KEY = "test";
  process.env.S3_BUCKET = "proofs";
  process.env.S3_REGION = "us-east-1";
  process.env.WORKER_SERVICE_TOKEN = "test-worker-token-000000000000000000";

  const mockReturning = vi.fn();
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockWhere = vi.fn();
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  const db = {
    select: mockSelect,
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    whereMock: mockWhere,
    returningMock: mockReturning,
  };

  return { mockDb: db, mockWrite: vi.fn().mockResolvedValue(undefined) };
});

// 2. Mock Database and Custom Middlewares
vi.mock("../../src/database/db", () => ({
  default: mockDb,
}));

vi.mock("hono/jwk", () => ({
  jwk: () => (c: Context, next: Next) => next(),
}));

// Mock storage interface (Bun S3 client)
vi.mock("../../src/storage", () => ({
  storage: { write: mockWrite },
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
      mockDb.whereMock.mockResolvedValue(mockResult);

      const res = await app.request(`/api/proof/${VALID_CASE_ID}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.proof).toEqual(mockResult);
    });
  });

  describe("POST /api/proof", () => {
    it("should upload file to storage and return 201 with public url index", async () => {
      // Create a fake File or FormData
      const mockResult = {
        id: "3",
        caseId: VALID_CASE_ID,
        mediaUrl: "http://localhost:9000/proofs/uploaded/path",
        type: "after",
      };
      mockDb.returningMock.mockResolvedValue([mockResult]);

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
      expect(data.proof.mediaUrl).toBe(
        "http://localhost:9000/proofs/uploaded/path"
      );
      expect(mockWrite).toHaveBeenCalled();
    });
  });
});

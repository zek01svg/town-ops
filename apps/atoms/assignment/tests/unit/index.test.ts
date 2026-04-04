import { vi, describe, it, expect, beforeEach } from "vitest";

import { updateAssignmentStatusSchema } from "../../src/validation-schemas";

// 1. Define hoisted mock variables first
const mocks = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockWhere: vi.fn(),
  mockSet: vi.fn(),
  mockValues: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
}));

// Set up the fluent return chains
mocks.mockWhere.mockReturnValue({ returning: mocks.mockReturning });
mocks.mockSet.mockReturnValue({ where: mocks.mockWhere });
mocks.mockValues.mockReturnValue({ returning: mocks.mockReturning });
mocks.mockInsert.mockReturnValue({ values: mocks.mockValues });
mocks.mockUpdate.mockReturnValue({ set: mocks.mockSet });

// 2. Mock modules using the hoisted variables
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

vi.mock("@townops/shared-ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  honoLogger: () => (c: any, next: any) => next(),
}));

vi.mock("../../src/database/db", () => ({
  default: {
    insert: mocks.mockInsert,
    update: mocks.mockUpdate,
    query: {
      assignments: { findFirst: mocks.mockFindFirst },
    },
    transaction: mocks.mockTransaction,
  },
}));

const { mockReturning, mockInsert, mockFindFirst, mockTransaction } = mocks;

/* eslint-disable import/first */
import { app } from "../../src/index";
/* eslint-enable import/first */

const VALID_CASE_ID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_ASSIGNMENT_ID = "223e4567-e89b-12d3-a456-426614174001";
const VALID_CONTRACTOR_ID = "323e4567-e89b-12d3-a456-426614174002";

const MOCK_ASSIGNMENT = {
  id: VALID_ASSIGNMENT_ID,
  caseId: VALID_CASE_ID,
  contractorId: VALID_CONTRACTOR_ID,
  status: "PENDING_ACCEPTANCE",
  source: "AUTO_ASSIGN",
  assignedAt: new Date().toISOString(),
  responseDueAt: new Date(Date.now() + 3_600_000 * 2).toISOString(),
  acceptedAt: null,
  reassignedFromAssignmentId: null,
  notes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("Assignment Atom - Validation Schemas", () => {
  it("should validate a correct status update request", () => {
    const result = updateAssignmentStatusSchema.safeParse({
      status: "ACCEPTED",
      changedBy: "test-user",
      reason: "Contractor confirmed",
    });
    expect(result.success).toBe(true);
  });

  it("should fail validation for empty changedBy", () => {
    const result = updateAssignmentStatusSchema.safeParse({
      status: "ACCEPTED",
      changedBy: "",
    });
    expect(result.success).toBe(false);
  });

  it("should fail validation for invalid status", () => {
    const result = updateAssignmentStatusSchema.safeParse({
      status: "INVALID_STATUS",
      changedBy: "test-user",
    });
    expect(result.success).toBe(false);
  });

  it("should accept all valid statuses", () => {
    const validStatuses = [
      "PENDING_ACCEPTANCE",
      "ACCEPTED",
      "BREACHED",
      "REASSIGNED",
      "CANCELLED",
      "COMPLETED",
    ];
    for (const status of validStatuses) {
      const result = updateAssignmentStatusSchema.safeParse({
        status,
        changedBy: "user",
      });
      expect(result.success, `Expected ${status} to be valid`).toBe(true);
    }
  });
});

describe("Assignment Atom - HTTP Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return 200 healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("POST /api/assignments", () => {
    it("should create assignment and return 201", async () => {
      mockReturning.mockResolvedValueOnce([MOCK_ASSIGNMENT]);

      const res = await app.request("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: VALID_CASE_ID,
          contractorId: VALID_CONTRACTOR_ID,
          source: "AUTO_ASSIGN",
          responseDueAt: MOCK_ASSIGNMENT.responseDueAt,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.assignments).toBeDefined();
      expect(data.assignments.caseId).toBe(VALID_CASE_ID);
      expect(mockInsert).toHaveBeenCalledOnce();
    });

    it("should return 400 for missing required fields", async () => {
      const res = await app.request("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: VALID_CASE_ID }), // missing contractorId, source, responseDueAt
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });
  });

  describe("GET /api/assignments/:case_id", () => {
    it("should return 200 with assignment when found", async () => {
      mockFindFirst.mockResolvedValueOnce(MOCK_ASSIGNMENT);

      const res = await app.request(`/api/assignments/${VALID_CASE_ID}`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignments).toBeDefined();
      expect(data.assignments.id).toBe(VALID_ASSIGNMENT_ID);
    });

    it("should return 200 with undefined when case has no assignment", async () => {
      mockFindFirst.mockResolvedValueOnce(undefined);

      const res = await app.request(`/api/assignments/${VALID_CASE_ID}`);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignments).toBeUndefined();
    });

    it("should return 400 for non-UUID case_id param", async () => {
      const res = await app.request("/api/assignments/not-a-valid-uuid");

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });
  });

  describe("PUT /api/assignments/:id/status", () => {
    it("should update status, set acceptedAt, and record history — returns 200", async () => {
      const updatedAssignment = {
        ...MOCK_ASSIGNMENT,
        status: "ACCEPTED",
        acceptedAt: new Date().toISOString(),
      };
      mockTransaction.mockImplementation(async (cb: (tx: any) => any) => {
        const tx = {
          query: {
            assignments: {
              findFirst: vi
                .fn()
                .mockResolvedValue({ status: "PENDING_ACCEPTANCE" }),
            },
          },
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([updatedAssignment]),
              }),
            }),
          }),
          insert: vi
            .fn()
            .mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        };
        return cb(tx);
      });

      const res = await app.request(
        `/api/assignments/${VALID_ASSIGNMENT_ID}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "ACCEPTED",
            changedBy: "contractor-xyz",
            reason: "Accepted via app",
          }),
        }
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.assignments.status).toBe("ACCEPTED");
      expect(data.assignments.acceptedAt).not.toBeNull();
    });

    it("should return 404 when assignment does not exist", async () => {
      mockTransaction.mockImplementation(async (cb: (tx: any) => any) => {
        const tx = {
          query: {
            assignments: { findFirst: vi.fn().mockResolvedValue(null) },
          },
          update: vi.fn(),
          insert: vi.fn(),
        };
        return cb(tx);
      });

      const res = await app.request(
        `/api/assignments/${VALID_ASSIGNMENT_ID}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ACCEPTED", changedBy: "user" }),
        }
      );

      expect(res.status).toBe(404);
    });

    it("should return 400 for invalid status value", async () => {
      const res = await app.request(
        `/api/assignments/${VALID_ASSIGNMENT_ID}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "INVALID", changedBy: "user" }),
        }
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 400 for non-UUID id param", async () => {
      const res = await app.request("/api/assignments/not-a-uuid/status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ACCEPTED", changedBy: "user" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });
  });
});

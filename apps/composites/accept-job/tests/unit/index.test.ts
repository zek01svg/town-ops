import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.APPOINTMENT_ATOM_URL = "http://appointment-atom";
  process.env.PORT = "6003";
  process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
});

// 2. Mock Shared Libraries
vi.mock("@townops/shared-ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  honoLogger: () => (c: any, next: any) => next(),
  rabbitmqClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(true),
  },
}));

// Mock jwk middleware to bypass auth
vi.mock("hono/jwk", () => ({
  jwk: () => (c: any, next: any) => next(),
}));

/* eslint-disable import/first */
import { hc } from "hono/client";

import { app } from "../../src/index";
/* eslint-enable import/first */

// 3. Mock Hono Client
vi.mock("hono/client", () => ({
  hc: vi.fn(),
}));

const validBody = {
  case_id: "123e4567-e89b-12d3-a456-426614174000",
  assignment_id: "223e4567-e89b-12d3-a456-426614174001",
  contractor_id: "323e4567-e89b-12d3-a456-426614174002",
  start_time: "2026-04-10T09:00:00+08:00",
  end_time: "2026-04-10T11:00:00+08:00",
};

const mockAssignmentUpdate = vi.fn();
const mockCaseUpdate = vi.fn();
const mockAppointmentCreate = vi.fn();

function buildMockClients(
  assignmentOk: boolean,
  caseOk: boolean,
  appointmentOk: boolean
) {
  const assignmentClient = {
    api: {
      assignments: {
        ":id": {
          status: {
            $put: mockAssignmentUpdate,
          },
        },
      },
    },
  };

  const caseClient = {
    api: {
      cases: {
        "update-case-status": { $put: mockCaseUpdate },
      },
    },
  };

  const appointmentClient = {
    api: {
      appointments: {
        $post: mockAppointmentCreate,
      },
    },
  };

  mockAssignmentUpdate.mockResolvedValue({
    ok: assignmentOk,
    json: async () => ({
      assignments: { id: validBody.assignment_id, status: "ACCEPTED" },
    }),
  });

  mockCaseUpdate.mockResolvedValue({
    ok: caseOk,
    json: async () => ({
      cases: { id: validBody.case_id, status: "in_progress" },
    }),
  });

  mockAppointmentCreate.mockResolvedValue({
    ok: appointmentOk,
    json: async () => ({
      appointment: { id: "appt-uuid", caseId: validBody.case_id },
    }),
  });

  (hc as any).mockImplementation((url: string) => {
    if (url === "http://assignment-atom") return assignmentClient;
    if (url === "http://case-atom") return caseClient;
    if (url === "http://appointment-atom") return appointmentClient;
    return {};
  });
}

describe("Accept Job Composite - Unit Tests", () => {
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

  describe("PUT /api/jobs/accept-job", () => {
    it("should accept job successfully when all steps succeed", async () => {
      buildMockClients(true, true, true);

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toBe("Job accepted successfully");
      expect(data.assignment).toBeDefined();
      expect(data.case).toBeDefined();
      expect(data.appointment).toBeDefined();
      // All 3 downstream calls made
      expect(mockAssignmentUpdate).toHaveBeenCalledOnce();
      expect(mockCaseUpdate).toHaveBeenCalledOnce();
      expect(mockAppointmentCreate).toHaveBeenCalledOnce();
    });

    it("should return 400 for validation failure (missing required field)", async () => {
      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 503 and no rollback when step 1 (assignment) fails", async () => {
      buildMockClients(false, true, true);

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Failed to update assignment");
      // Only assignment called; no case or appointment
      expect(mockAssignmentUpdate).toHaveBeenCalledOnce();
      expect(mockCaseUpdate).not.toHaveBeenCalled();
      expect(mockAppointmentCreate).not.toHaveBeenCalled();
    });

    it("should return 503 and revert assignment when step 2 (case) fails", async () => {
      buildMockClients(true, false, true);

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Failed to update case status");
      // Assignment called twice: step 1 + rollback
      expect(mockAssignmentUpdate).toHaveBeenCalledTimes(2);
      // Rollback call has status: "pending"
      expect(mockAssignmentUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          json: expect.objectContaining({ status: "PENDING_ACCEPTANCE" }),
        }),
        expect.anything()
      );
      expect(mockAppointmentCreate).not.toHaveBeenCalled();
    });

    it("should return 503 and revert both assignment and case when step 3 (appointment) fails", async () => {
      buildMockClients(true, true, false);

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Failed to create appointment");
      // Assignment: step 1 + rollback = 2 calls
      expect(mockAssignmentUpdate).toHaveBeenCalledTimes(2);
      // Case: step 2 + rollback = 2 calls
      expect(mockCaseUpdate).toHaveBeenCalledTimes(2);
      // Case rollback sets status: "dispatched"
      expect(mockCaseUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          json: expect.objectContaining({ status: "dispatched" }),
        }),
        expect.anything()
      );
    });
  });
});

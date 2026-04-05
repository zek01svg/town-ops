import { vi, describe, it, expect, beforeEach } from "vitest";

// 1. Environment Hoisting
vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.APPOINTMENT_ATOM_URL = "http://appointment-atom";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.PORT = "6006";
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
  corsOrigins: () => ["http://localhost:5173"],
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
  appointmentId: "123e4567-e89b-12d3-a456-426614174000",
  residentId: "223e4567-e89b-12d3-a456-426614174001",
  caseId: "323e4567-e89b-12d3-a456-426614174002",
  assignmentId: "423e4567-e89b-12d3-a456-426614174003",
  newStartTime: "2026-04-10T09:00:00+08:00",
  newEndTime: "2026-04-10T11:00:00+08:00",
};

const mockResidentGet = vi.fn();
const mockAppointmentCreate = vi.fn();
const mockCaseUpdate = vi.fn();

function buildMockClients(
  residentPayload: { ok: boolean; data?: any },
  appointmentOk: boolean,
  caseOk: boolean
) {
  const residentClient = {
    api: {
      residents: {
        ":id": { $get: mockResidentGet },
      },
    },
  };

  const appointmentClient = {
    api: {
      appointments: { $post: mockAppointmentCreate },
    },
  };

  const caseClient = {
    api: {
      cases: {
        "update-case-status": { $put: mockCaseUpdate },
      },
    },
  };

  mockResidentGet.mockResolvedValue({
    ok: residentPayload.ok,
    json: async () =>
      residentPayload.data ?? {
        residents: { id: validBody.residentId, is_active: true },
      },
  });

  mockAppointmentCreate.mockResolvedValue({
    ok: appointmentOk,
    json: async () => ({ appointment: { id: "new-appt-uuid" } }),
  });

  mockCaseUpdate.mockResolvedValue({
    ok: caseOk,
    json: async () => ({
      cases: { id: validBody.caseId, status: "dispatched" },
    }),
  });

  (hc as any).mockImplementation((url: string) => {
    if (url === "http://resident-atom") return residentClient;
    if (url === "http://appointment-atom") return appointmentClient;
    if (url === "http://case-atom") return caseClient;
    return {};
  });
}

describe("Reschedule Job Composite - Unit Tests", () => {
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

  describe("POST /api/cases/reschedule-job", () => {
    it("should reschedule job successfully when all steps succeed", async () => {
      buildMockClients({ ok: true }, true, true);

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("rescheduled");
      expect(data.message).toBe("Appointment successfully rescheduled");
      expect(data.caseId).toBe(validBody.caseId);
      expect(mockResidentGet).toHaveBeenCalledOnce();
      expect(mockAppointmentCreate).toHaveBeenCalledOnce();
      expect(mockCaseUpdate).toHaveBeenCalledOnce();
    });

    it("should return 400 for validation failure (missing required fields)", async () => {
      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ residentId: "not-a-uuid" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("should return 404 when resident is not found", async () => {
      buildMockClients({ ok: false }, true, true);

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Resident not found");
      expect(mockAppointmentCreate).not.toHaveBeenCalled();
      expect(mockCaseUpdate).not.toHaveBeenCalled();
    });

    it("should return 422 when resident is not active", async () => {
      buildMockClients(
        {
          ok: true,
          data: { residents: { id: validBody.residentId, is_active: false } },
        },
        true,
        true
      );

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe("Resident is not active");
      expect(mockAppointmentCreate).not.toHaveBeenCalled();
    });

    it("should return 503 when appointment creation fails", async () => {
      buildMockClients({ ok: true }, false, true);

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Failed to create appointment");
      expect(mockCaseUpdate).not.toHaveBeenCalled();
    });

    it("should return 503 when case status update fails", async () => {
      buildMockClients({ ok: true }, true, false);

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("Failed to update case status");
    });

    it("should succeed when resident data is returned as an array", async () => {
      buildMockClients(
        {
          ok: true,
          data: { residents: [{ id: validBody.residentId, is_active: true }] },
        },
        true,
        true
      );

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("rescheduled");
    });

    it("should return 422 when resident in array format is not active", async () => {
      buildMockClients(
        {
          ok: true,
          data: { residents: [{ id: validBody.residentId, is_active: false }] },
        },
        true,
        true
      );

      const res = await app.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe("Resident is not active");
    });
  });
});

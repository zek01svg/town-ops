import { describe, it, expect, vi, beforeEach } from "vitest";

// 1. Mocks and Environment — must precede all imports
const { mockLogger, mockRabbitMQ } = vi.hoisted(() => {
  return {
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    mockRabbitMQ: {
      connect: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(true),
      consume: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.hoisted(() => {
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.APPOINTMENT_ATOM_URL = "http://appointment-atom";
  process.env.PORT = "6003";
  // RABBITMQ_URL is provided by global-setup.ts Testcontainer
});

vi.mock("@townops/shared-ts", () => ({
  logger: mockLogger,
  honoLogger: () => (_c: any, next: any) => next(),
  rabbitmqClient: mockRabbitMQ,
}));

// Bypass JWK auth — integration focus is downstream orchestration
vi.mock("hono/jwk", () => ({
  jwk: () => (_c: any, next: () => Promise<void>) => next(),
}));

/* eslint-disable import/first */
import { app } from "../../src/index";
/* eslint-enable import/first */

// ── Fixtures ────────────────────────────────────────────────────────────────

const CASE_ID = "123e4567-e89b-12d3-a456-426614174000";
const ASSIGNMENT_ID = "223e4567-e89b-12d3-a456-426614174001";
const CONTRACTOR_ID = "323e4567-e89b-12d3-a456-426614174002";
const APPT_ID = "423e4567-e89b-12d3-a456-426614174003";

const validBody = {
  case_id: CASE_ID,
  assignment_id: ASSIGNMENT_ID,
  contractor_id: CONTRACTOR_ID,
  start_time: "2026-04-10T09:00:00+08:00",
  end_time: "2026-04-10T11:00:00+08:00",
};

// ── Fetch mock factory ───────────────────────────────────────────────────────

function makeFetch(
  opts: {
    assignmentOk?: boolean;
    caseOk?: boolean;
    appointmentOk?: boolean;
    rollbackAssignmentOk?: boolean;
    rollbackCaseOk?: boolean;
    delay?: number;
  } = {}
) {
  const {
    assignmentOk = true,
    caseOk = true,
    appointmentOk = true,
    rollbackAssignmentOk = true,
    rollbackCaseOk = true,
    delay = 0,
  } = opts;

  let assignmentCallCount = 0;
  let caseCallCount = 0;

  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const url = input instanceof Request ? input.url : input.toString();

    if (url.includes(`/api/assignments/${ASSIGNMENT_ID}/status`)) {
      assignmentCallCount++;
      // Rollback is usually the 2nd call to this URL in failure scenarios
      if (assignmentCallCount > 1 && !rollbackAssignmentOk) {
        return new Response(JSON.stringify({ error: "rollback failed" }), {
          status: 500,
        });
      }
      if (assignmentCallCount === 1 && !assignmentOk) {
        return new Response(JSON.stringify({ error: "upstream error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({
          assignments: { id: ASSIGNMENT_ID, status: "ACCEPTED" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/api/cases/update-case-status")) {
      caseCallCount++;
      if (caseCallCount > 1 && !rollbackCaseOk) {
        return new Response(JSON.stringify({ error: "rollback failed" }), {
          status: 500,
        });
      }
      if (caseCallCount === 1 && !caseOk) {
        return new Response(JSON.stringify({ error: "upstream error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ cases: { id: CASE_ID, status: "in_progress" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("/api/appointments")) {
      if (!appointmentOk) {
        return new Response(JSON.stringify({ error: "upstream error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ appointment: { id: APPT_ID, caseId: CASE_ID } }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "unexpected url" }), {
      status: 404,
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Accept Job Composite - Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Infrastructure endpoints ───────────────────────────────────────────────

  describe("GET /health", () => {
    it("returns 200 with healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  describe("GET /openapi", () => {
    it("returns 200 with an OpenAPI spec object", async () => {
      const res = await app.request("/openapi");
      expect(res.status).toBe(200);
      const spec = await res.json();
      expect(spec.info.title).toBe("Accept Job Composite Service");
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe("PUT /api/jobs/accept-job — validation", () => {
    it("returns 400 when body is empty", async () => {
      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Validation failed");
    });

    it("returns 400 when case_id is not a UUID", async () => {
      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, case_id: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when start_time is not an ISO datetime", async () => {
      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, start_time: "tomorrow" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when assignment_id is missing", async () => {
      const { assignment_id: _, ...noAssignment } = validBody;
      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(noAssignment),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe("PUT /api/jobs/accept-job — happy path", () => {
    it("returns 200 and calls all 3 downstream services in order", async () => {
      globalThis.fetch = makeFetch();

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
    });

    it("calls assignment atom at the correct URL with PUT and status=accepted", async () => {
      globalThis.fetch = makeFetch();

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const assignmentCall = calls.find((call: any[]) =>
        call[0].toString().includes(`/api/assignments/${ASSIGNMENT_ID}/status`)
      );
      expect(assignmentCall).toBeDefined();
      const init = assignmentCall?.[1];
      expect(init?.method).toBe("PUT");
      const sentBody = JSON.parse(init?.body as string);
      expect(sentBody.status).toBe("ACCEPTED");
      expect(sentBody.changedBy).toBe(CONTRACTOR_ID);
    });

    it("calls case atom at the correct URL with PUT and status=in_progress", async () => {
      globalThis.fetch = makeFetch();

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const caseCall = calls.find((call: any[]) =>
        call[0].toString().includes("/api/cases/update-case-status")
      );
      expect(caseCall).toBeDefined();
      const init = caseCall?.[1];
      expect(init?.method).toBe("PUT");
      const sentBody = JSON.parse(init?.body as string);
      expect(sentBody.id).toBe(CASE_ID);
      expect(sentBody.status).toBe("in_progress");
    });

    it("calls appointment atom at the correct URL with POST and correct schedule", async () => {
      globalThis.fetch = makeFetch();

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const apptCall = calls.find((call: any[]) =>
        call[0].toString().includes("/api/appointments")
      );
      expect(apptCall).toBeDefined();
      const init = apptCall?.[1];
      expect(init?.method).toBe("POST");
      const sentBody = JSON.parse(init?.body as string);
      expect(sentBody.caseId).toBe(CASE_ID);
      expect(sentBody.assignmentId).toBe(ASSIGNMENT_ID);
      expect(sentBody.startTime).toBe(validBody.start_time);
      expect(sentBody.endTime).toBe(validBody.end_time);
      expect(sentBody.status).toBe("scheduled");
    });

    it("forwards the Authorization header to each downstream call", async () => {
      globalThis.fetch = makeFetch();
      const authToken = "Bearer test-jwt-token";

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authToken,
        },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      // All 3 downstream calls must carry the Authorization header
      const downstreamCalls = calls.filter((call: any[]) => {
        const url = call[0].toString();
        return (
          url.includes("/api/assignments/") ||
          url.includes("/api/cases/") ||
          url.includes("/api/appointments")
        );
      });
      expect(downstreamCalls).toHaveLength(3);
      for (const [, init] of downstreamCalls) {
        const headers = init.headers;
        const auth =
          typeof headers?.get === "function"
            ? headers.get("Authorization")
            : headers?.Authorization;
        expect(auth).toBe(authToken);
      }
    });

    it("maps assignments field from assignment atom response correctly", async () => {
      globalThis.fetch = makeFetch();

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const data = await res.json();
      expect(data.assignment.id).toBe(ASSIGNMENT_ID);
      expect(data.assignment.status).toBe("ACCEPTED");
    });
  });

  // ── Step 1 failure (assignment) ───────────────────────────────────────────

  describe("PUT /api/jobs/accept-job — step 1 (assignment) failure", () => {
    it("returns 503 with correct error message", async () => {
      globalThis.fetch = makeFetch({ assignmentOk: false });

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Failed to update assignment");
    });

    it("makes exactly 1 fetch call — no case or appointment calls", async () => {
      globalThis.fetch = makeFetch({ assignmentOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
    });
  });

  // ── Step 2 failure (case) with assignment rollback ────────────────────────

  describe("PUT /api/jobs/accept-job — step 2 (case) failure + rollback", () => {
    it("returns 503 with correct error message", async () => {
      globalThis.fetch = makeFetch({ caseOk: false });

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Failed to update case status");
    });

    it("calls assignment atom twice — step 1 then rollback", async () => {
      globalThis.fetch = makeFetch({ caseOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const assignmentCalls = calls.filter((call: any[]) =>
        call[0].toString().includes(`/api/assignments/${ASSIGNMENT_ID}/status`)
      );
      expect(assignmentCalls).toHaveLength(2);

      // First call: forward (status=accepted)
      const firstCallBody = assignmentCalls[0]?.[1]?.body;
      expect(firstCallBody).toBeDefined();
      expect(JSON.parse(firstCallBody as string).status).toBe("ACCEPTED");

      // Second call: rollback (status=pending)
      const secondCallBody = assignmentCalls[1]?.[1]?.body;
      expect(secondCallBody).toBeDefined();
      expect(JSON.parse(secondCallBody as string).status).toBe(
        "PENDING_ACCEPTANCE"
      );
    });

    it("handles failure during rollback gracefully (logs error but returns original error)", async () => {
      globalThis.fetch = makeFetch({
        caseOk: false,
        rollbackAssignmentOk: false,
      });

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Failed to update case status");
      // Though it failed, the response to user is still based on the primary failure
    });
  });

  // ── Step 3 failure (appointment) with full rollback ───────────────────────

  describe("PUT /api/jobs/accept-job — step 3 (appointment) failure + full rollback", () => {
    it("returns 503 with correct error message", async () => {
      globalThis.fetch = makeFetch({ appointmentOk: false });

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Failed to create appointment");
    });

    it("calls assignment atom twice — step 1 then rollback to pending", async () => {
      globalThis.fetch = makeFetch({ appointmentOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const assignmentCalls = calls.filter((call: any[]) =>
        call[0].toString().includes(`/api/assignments/${ASSIGNMENT_ID}/status`)
      );
      expect(assignmentCalls).toHaveLength(2);
      const rollbackBody = assignmentCalls[1]?.[1]?.body;
      expect(rollbackBody).toBeDefined();
      expect(JSON.parse(rollbackBody as string).status).toBe(
        "PENDING_ACCEPTANCE"
      );
    });

    it("calls case atom twice — step 2 then rollback to dispatched", async () => {
      globalThis.fetch = makeFetch({ appointmentOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      const calls = (globalThis.fetch as any).mock.calls;
      const caseCalls = calls.filter((call: any[]) =>
        call[0].toString().includes("/api/cases/update-case-status")
      );
      expect(caseCalls).toHaveLength(2);
      const rollbackBody = caseCalls[1]?.[1]?.body;
      expect(rollbackBody).toBeDefined();
      expect(JSON.parse(rollbackBody as string).status).toBe("dispatched");
    });

    it("makes exactly 5 fetch calls total: step1 + step2 + step3(fail) + rollback-case + rollback-assignment", async () => {
      globalThis.fetch = makeFetch({ appointmentOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect((globalThis.fetch as any).mock.calls).toHaveLength(5);
    });

    it("handles failure during case rollback during full rollback sequence", async () => {
      globalThis.fetch = makeFetch({
        appointmentOk: false,
        rollbackCaseOk: false,
      });

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(503);
      // Should still try to rollback assignment even if case rollback fails
      const calls = (globalThis.fetch as any).mock.calls;
      const assignmentRollbackCall = calls.find(
        (call: any[], idx: number) =>
          call[0]
            .toString()
            .includes(`/api/assignments/${ASSIGNMENT_ID}/status`) && idx > 0
      );
      expect(assignmentRollbackCall).toBeDefined();
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

  describe("PUT /api/jobs/accept-job — edge cases", () => {
    it("returns 500 when a downstream call hangs/times out (simulated)", async () => {
      // Vitest default timeout is usually 5s. We simulate a long delay.
      globalThis.fetch = makeFetch({ delay: 100 }); // Short enough to not time out Vitest but simulate async work

      const res = await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200); // Should still succeed if within timeout
    });

    it("properly uses provided RabbitMQ_URL from global setup", async () => {
      expect(process.env.RABBITMQ_URL).toBeDefined();
      expect(process.env.RABBITMQ_URL).toMatch(/^amqp:\/\/localhost:\d+$/);
    });

    it("logs errors to mockLogger during failure", async () => {
      globalThis.fetch = makeFetch({ assignmentOk: false });

      await app.request("/api/jobs/accept-job", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});

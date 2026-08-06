import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  fetchResolving,
  officerAuth,
  residentAuth,
  successResult,
  validBody,
} from "./helpers";
import {
  noAccessRoute,
  ownedCaseRecord,
  putJson,
  recoveryAppointmentId,
  recoveryCaseId,
  recoveryContractorAuth,
  recoveryFetch,
  replacementBody,
  replacementRoute,
  scheduledRecoveryAppointment,
} from "./recovery-helpers";

/**
 * PRS-151-F, F5: proves the Gateway's Temporal-down contract holds across
 * its whole surface in one place, rather than trusting nine scattered
 * per-route assertions to stay consistent with each other. `code: 14` is
 * grpc's UNAVAILABLE, the same shape `isTemporalUnavailable` (app.ts) keys
 * off, and the idiom `open-case.test.ts:119-138` already exercises for one
 * route.
 */
const unavailable = Object.assign(new Error("service unavailable"), {
  code: 14,
});

function rejectingWorkflowClient() {
  return {
    executeUpdateWithStart: vi.fn().mockRejectedValue(unavailable),
    start: vi.fn().mockRejectedValue(unavailable),
  };
}

describe("Gateway degraded-service contract: reads survive a Temporal outage", () => {
  // `/api/me` is the *only* read that touches Temporal (a fire-and-forget
  // provisioning nudge for an ABSENT Resident profile) — everything else in
  // this describe block never calls the rejecting workflow client at all,
  // which the 200 assertions below prove implicitly: an accidental Temporal
  // touch on a read route would surface the rejection as a non-200.
  it("GET /api/me still 200s for a Resident and still fires the provisioning nudge", async () => {
    const { start } = rejectingWorkflowClient();
    // `!ok` or a rejected fetch here yields UNAVAILABLE, which 503s *before*
    // ever reaching the workflow client (app.ts:1352) — the trap this test
    // exists to avoid. 200 + `{ residents: [] }` is required to land on
    // ABSENT instead (app.ts:549-554).
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ residents: [] })),
      { authenticate: residentAuth, start }
    );

    const response = await app.request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { provisioningState: "PROVISIONING" },
    });
    // The regression this catches: if `ensureResidentProvisioning`'s
    // fire-and-forget guard (`.catch(() => undefined)`, app.ts:580) or the
    // call itself were deleted, this assertion is the only thing that would
    // notice — the 200 above passes either way.
    expect(start).toHaveBeenCalled();
  });

  it("GET /api/cases stays 200", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({ caseRecord: successResult.data }),
      { start: rejectingWorkflowClient().start }
    );

    const response = await app.request("/api/cases");

    expect(response.status).toBe(200);
  });

  it("GET /api/cases/:caseId stays 200", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({ caseRecord: successResult.data, appointments: [] }),
      { start: rejectingWorkflowClient().start }
    );

    const response = await app.request(`/api/cases/${successResult.data.id}`);

    expect(response.status).toBe(200);
  });

  it("GET /api/cases/:caseId/timeline stays 200", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({ caseRecord: successResult.data, appointments: [] }),
      { start: rejectingWorkflowClient().start }
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/timeline`
    );

    expect(response.status).toBe(200);
  });

  it("GET /api/cases/:caseId/effects stays 200", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ effects: [] })),
      { start: rejectingWorkflowClient().start }
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/effects`
    );

    expect(response.status).toBe(200);
  });

  it("GET /api/officer-attention stays 200", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ attentions: [] })),
      { start: rejectingWorkflowClient().start }
    );

    const response = await app.request("/api/officer-attention");

    expect(response.status).toBe(200);
  });
});

describe("Gateway degraded-service contract: mutations 503 TEMPORAL_UNAVAILABLE", () => {
  it("POST /api/cases (openCase)", async () => {
    const { app } = createApp(vi.fn().mockRejectedValue(unavailable));

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/cancel (cancelCase)", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ cases: [successResult.data] })),
      { authenticate: officerAuth }
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/cancel`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ reason: "No longer needed" }),
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/allocation-attempts/:attemptId/acceptance (acceptAllocation)", async () => {
    const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
    const contractorAuth: MiddlewareHandler = async (c, next) => {
      c.set("jwtPayload", {
        sub: "e5e5e5e5-5555-4555-8555-555555555555",
        role: "contractor",
        contractorId,
      });
      await next();
    };
    const assignmentId = "aaaaaaaa-1111-4111-8111-111111111111";
    const attemptId = "bbbbbbbb-1111-4111-8111-111111111111";
    const assignment = {
      id: assignmentId,
      caseId: successResult.data.id,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const attempt = {
      id: attemptId,
      assignmentId,
      contractorId,
      source: "AUTO_ASSIGN" as const,
      status: "PENDING_ACCEPTANCE" as const,
      acceptanceSlaMs: 60_000,
      deadlineAt: "2026-07-22T00:01:00.000Z",
      actorId: "00000000-0000-0000-0000-000000000000",
      actorRole: "SYSTEM",
      reason: null,
      operationId: "allocate/1",
      createdAt: "2026-07-22T00:00:00.000Z",
    };
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ assignment, attempt })),
      { authenticate: contractorAuth }
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attemptId}/acceptance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
        }),
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/appointments/:appointmentId/replacement (replaceAppointment)", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({
        caseRecord: ownedCaseRecord,
        appointments: [scheduledRecoveryAppointment],
      })
    );

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/completion (completeCase)", async () => {
    const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
    const contractorAuth: MiddlewareHandler = async (c, next) => {
      c.set("jwtPayload", {
        sub: "e5e5e5e5-5555-4555-8555-555555555555",
        role: "contractor",
        contractorId,
      });
      await next();
    };
    const assignmentId = "a1a1a1a1-1111-4111-8111-111111111111";
    const attemptId = "b1b1b1b1-1111-4111-8111-111111111111";
    const appointmentId = "d1d1d1d1-1111-4111-8111-111111111111";
    const assignment = {
      id: assignmentId,
      caseId: successResult.data.id,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    const attempt = {
      id: attemptId,
      assignmentId,
      contractorId,
      source: "AUTO_ASSIGN",
      status: "ACCEPTED",
      acceptanceSlaMs: 60_000,
      deadlineAt: "2030-01-01T00:01:00.000Z",
      actorId: "00000000-0000-0000-0000-000000000000",
      actorRole: "SYSTEM",
      reason: null,
      operationId: "allocate/1",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const appointment = {
      id: appointmentId,
      caseId: successResult.data.id,
      assignmentId,
      attemptId,
      contractorId,
      startTime: "2030-01-01T09:00:00.000Z",
      endTime: "2030-01-01T10:00:00.000Z",
      status: "IN_PROGRESS",
      reason: null,
      operationId: "accept/1/confirm",
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/api/assignments/by-case/")) {
        return Response.json({ assignment, attempt });
      }
      if (href.includes("/api/appointments/")) {
        return Response.json({ appointments: [appointment] });
      }
      if (href.includes("/api/cases/")) {
        return Response.json({
          cases: [{ ...successResult.data, status: "in_progress" }],
        });
      }
      return Response.json({ proof: [] });
    });
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchImpl,
      {
        authenticate: contractorAuth,
      }
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/completion`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          report: "Work completed.",
          proofItemIds: [randomUUID(), randomUUID()],
        }),
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("POST /api/cases/:caseId/allocation-attempts (manualAllocation)", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchResolving(Response.json({ cases: [successResult.data] }))
    );

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ contractorId: randomUUID() }),
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/appointments/:appointmentId/no-access (reportNoAccess)", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({ appointments: [scheduledRecoveryAppointment] }),
      { authenticate: recoveryContractorAuth }
    );

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("PUT /api/cases/:caseId/appointments/:appointmentId/start-work (startWork)", async () => {
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      recoveryFetch({ appointments: [scheduledRecoveryAppointment] }),
      { authenticate: recoveryContractorAuth }
    );

    const response = await app.request(
      `/api/cases/${recoveryCaseId}/appointments/${recoveryAppointmentId}/start-work`,
      {
        method: "PUT",
        headers: { "Idempotency-Key": randomUUID() },
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });
});

describe("Gateway degraded-service contract: the two named exceptions", () => {
  // repairEffect (app.ts:2959-2984) serves both /retry and /waive from one
  // handler with a single catch-all: it never distinguishes a genuine
  // Temporal outage from any other rejection, folding both into
  // WORKFLOW_UPDATE_PENDING at 503 — the same status a real
  // `*_ATOM_UNAVAILABLE` uses, which is exactly the collision F3's
  // `get-query-client.ts` branch order has to resolve (code before status).
  it("POST /api/cases/:caseId/effects/:effectId/retry folds a Temporal outage into WORKFLOW_UPDATE_PENDING, not TEMPORAL_UNAVAILABLE", async () => {
    const { app } = createApp(vi.fn().mockRejectedValue(unavailable));

    const response = await app.request(
      `/api/cases/${successResult.data.id}/effects/${encodeURIComponent("some-effect-id")}/retry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "WORKFLOW_UPDATE_PENDING", retryable: true },
    });
  });

  // POST /api/cases/:caseId/proof-items never calls the workflow client at
  // all (it only ever talks to the Proof atom), so it is excluded from the
  // uniform-503 loop above rather than asserted against — there is nothing
  // Temporal-shaped to prove about a route that never touches Temporal.
});

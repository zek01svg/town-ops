import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  officerAuth,
  rejectingAuth,
  residentAuth,
  successResult,
} from "./helpers";
import {
  noAccessRoute,
  putJson,
  recoveryAppointmentId,
  recoveryCaseId,
  recoveryContractorAuth,
  recoveryContractorId,
  recoveryFetch,
  scheduledRecoveryAppointment,
  unusableTokenAuth,
} from "./recovery-helpers";

describe("Gateway Contractor No Access (PRS-146)", () => {
  const noAccessSuccess = {
    kind: "SUCCESS" as const,
    data: {
      appointment: {
        ...scheduledRecoveryAppointment,
        status: "NO_ACCESS" as const,
      },
      case: {
        ...successResult.data,
        status: "PENDING_RESIDENT_INPUT" as const,
      },
    },
  };

  it("reports No Access through Temporal and returns the NO_ACCESS envelope", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue(noAccessSuccess);
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        appointment: { status: "NO_ACCESS" },
        case: { status: "PENDING_RESIDENT_INPUT" },
      },
      operation: { caseId: recoveryCaseId },
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "reportNoAccess",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "CONTRACTOR",
            contractorId: recoveryContractorId,
            caseId: recoveryCaseId,
            appointmentId: recoveryAppointmentId,
            startTime: scheduledRecoveryAppointment.startTime,
            endTime: scheduledRecoveryAppointment.endTime,
          }),
        ],
      })
    );
  });

  it("does not pass a request body to the Workflow", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue(noAccessSuccess);
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      { method: "PUT", headers: { "Idempotency-Key": randomUUID() } }
    );

    expect(response.status).toBe(200);
    expect(executeUpdateWithStart.mock.calls[0][1].args[0]).not.toHaveProperty(
      "reason"
    );
  });

  it("rejects an unusable token with 401 before reading any atom", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: unusableTokenAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_TOKEN", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("returns the middleware's 401 when no usable token is presented", async () => {
    const { app } = createApp(undefined, vi.fn(), {
      authenticate: rejectingAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(401);
  });

  it("rejects an Officer and a Resident with 403 — No Access is a Contractor report", async () => {
    const fetchImpl = vi.fn();
    const officer = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });
    const resident = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const officerResponse = await officer.app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );
    const residentResponse = await resident.app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(officerResponse.status).toBe(403);
    expect(residentResponse.status).toBe(403);
    expect(await officerResponse.json()).toMatchObject({
      error: { code: "FORBIDDEN", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hides another Contractor's Appointment behind a 404", async () => {
    const fetchImpl = recoveryFetch({
      appointments: [
        { ...scheduledRecoveryAppointment, contractorId: randomUUID() },
      ],
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-UUID Idempotency-Key", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const missing = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      { method: "PUT" }
    );
    const invalid = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      { method: "PUT", headers: { "Idempotency-Key": "not-a-uuid" } }
    );

    expect(missing.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-UUID path params", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const badCase = await app.request(
      noAccessRoute("not-a-uuid", recoveryAppointmentId),
      putJson()
    );
    const badAppointment = await app.request(
      noAccessRoute(recoveryCaseId, "not-a-uuid"),
      putJson()
    );

    expect(badCase.status).toBe(400);
    expect(badAppointment.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a request body", async () => {
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson({ reason: "Nobody was home" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  const outcomes: { kind: string; status: number; code: string }[] = [
    {
      kind: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    },
    {
      kind: "NOT_IN_WINDOW",
      status: 409,
      code: "APPOINTMENT_NOT_IN_PROGRESS_WINDOW",
    },
    { kind: "NOT_SCHEDULED", status: 409, code: "NOT_SCHEDULED" },
    { kind: "CASE_TERMINAL", status: 409, code: "CASE_TERMINAL" },
    { kind: "WRONG_CONTRACTOR", status: 404, code: "APPOINTMENT_NOT_FOUND" },
    {
      kind: "APPOINTMENT_MISMATCH",
      status: 404,
      code: "APPOINTMENT_NOT_FOUND",
    },
    { kind: "CASE_MISMATCH", status: 404, code: "APPOINTMENT_NOT_FOUND" },
  ];

  for (const outcome of outcomes) {
    it(`maps a Worker ${outcome.kind} to ${outcome.status} ${outcome.code}`, async () => {
      const executeUpdateWithStart = vi
        .fn()
        .mockResolvedValue({ kind: outcome.kind });
      const fetchImpl = recoveryFetch({
        appointments: [scheduledRecoveryAppointment],
      });
      const { app } = createApp(executeUpdateWithStart, fetchImpl, {
        authenticate: recoveryContractorAuth,
      });

      const response = await app.request(
        noAccessRoute(recoveryCaseId, recoveryAppointmentId),
        putJson()
      );

      expect(response.status).toBe(outcome.status);
      expect(await response.json()).toMatchObject({
        error: { code: outcome.code, retryable: false },
      });
    });
  }

  it("returns 504 with a Retry-After while the Update is still pending", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockReturnValue(new Promise(() => {}));
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(504);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toMatchObject({
      error: { code: "WORKFLOW_UPDATE_PENDING", retryable: true },
    });
  });

  it("returns 503 when Temporal is unavailable", async () => {
    const unavailable = Object.assign(new Error("service unavailable"), {
      code: 14,
    });
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchImpl,
      {
        authenticate: recoveryContractorAuth,
      }
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

  it("returns 500 when the Workflow answers with something off-contract", async () => {
    const fetchImpl = recoveryFetch({
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(
      vi.fn().mockResolvedValue({ kind: "NOT_A_REAL_OUTCOME" }),
      fetchImpl,
      { authenticate: recoveryContractorAuth }
    );

    const response = await app.request(
      noAccessRoute(recoveryCaseId, recoveryAppointmentId),
      putJson()
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "WORKFLOW_UPDATE_FAILED", retryable: false },
    });
  });
});

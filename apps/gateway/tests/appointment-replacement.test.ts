import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  officerAuth,
  officerId,
  otherResidentId,
  rejectingAuth,
  residentAuth,
  residentId,
  successResult,
} from "./helpers";
import {
  ownedCaseRecord,
  putJson,
  recoveryAppointmentId,
  recoveryCaseId,
  recoveryContractorAuth,
  recoveryContractorId,
  recoveryFetch,
  replacementAppointmentId,
  replacementBody,
  replacementRoute,
  scheduledRecoveryAppointment,
  unusableTokenAuth,
} from "./recovery-helpers";

describe("Gateway Appointment replacement (PRS-146)", () => {
  const noAccessAppointment = {
    ...scheduledRecoveryAppointment,
    status: "NO_ACCESS" as const,
  };
  const replacementSuccess = {
    kind: "SUCCESS" as const,
    data: {
      appointment: {
        ...scheduledRecoveryAppointment,
        id: replacementAppointmentId,
        startTime: replacementBody.startTime,
        endTime: replacementBody.endTime,
        operationId: "replace/1/appointment",
        createdAt: "2030-01-05T00:00:00.000Z",
      },
      case: { ...successResult.data, status: "ASSIGNED" as const },
    },
  };

  it("lets an Officer reschedule without any Case-ownership read", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue(replacementSuccess);
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        appointment: { id: replacementAppointmentId, status: "SCHEDULED" },
        case: { status: "ASSIGNED" },
      },
      operation: { caseId: recoveryCaseId },
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "replaceAppointment",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorId: officerId,
            actorRole: "OFFICER",
            caseId: recoveryCaseId,
            appointmentId: recoveryAppointmentId,
            input: replacementBody,
          }),
        ],
      })
    );
  });

  // The Workflow's AC4/AC5 gate can only read what the Gateway hands it.
  it("carries the looked-up Appointment's startTime and status into the Update", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue(replacementSuccess);
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [noAccessAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: officerAuth,
    });

    await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(executeUpdateWithStart.mock.calls[0][1].args[0]).toMatchObject({
      previousStartTime: noAccessAppointment.startTime,
      previousStatus: "NO_ACCESS",
    });
  });

  it("lets the owning Resident reschedule their own Case", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue(replacementSuccess);
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(200);
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "replaceAppointment",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorId: residentId,
            actorRole: "RESIDENT",
          }),
        ],
      })
    );
  });

  it("hides another Resident's Case behind a 404 without reaching Temporal", async () => {
    const executeUpdateWithStart = vi.fn();
    const fetchImpl = recoveryFetch({
      caseRecord: { ...ownedCaseRecord, residentId: otherResidentId },
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  // AC8: a Contractor cannot reschedule through the public API at all.
  it("rejects a Contractor with 403 before reading any atom", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects an unusable token with 401", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: unusableTokenAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_TOKEN", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the middleware's 401 when no usable token is presented", async () => {
    const { app } = createApp(undefined, vi.fn(), {
      authenticate: rejectingAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(401);
  });

  it("rejects an input without a reason, a past-ordered interval, or unknown keys", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const noReason = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson({
        startTime: replacementBody.startTime,
        endTime: replacementBody.endTime,
      })
    );
    const inverted = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson({
        ...replacementBody,
        endTime: "2030-02-01T08:00:00.000Z",
      })
    );
    const extraKey = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson({ ...replacementBody, contractorId: recoveryContractorId })
    );
    const noBody = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      { method: "PUT", headers: { "Idempotency-Key": randomUUID() } }
    );

    expect(noReason.status).toBe(400);
    expect(inverted.status).toBe(400);
    expect(extraKey.status).toBe(400);
    expect(noBody.status).toBe(400);
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("returns 404 when the Appointment is not on this Case", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [],
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("returns 503 when the Case atom cannot answer the Resident ownership check", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/api/cases")) {
        return new Response("boom", { status: 500 });
      }
      return Response.json({ appointments: [scheduledRecoveryAppointment] });
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_ATOM_UNAVAILABLE", retryable: true },
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
      kind: "APPOINTMENT_CONFLICT",
      status: 409,
      code: "APPOINTMENT_CONFLICT",
    },
    { kind: "NOT_FUTURE", status: 409, code: "NOT_FUTURE" },
    { kind: "NOT_REPLACEABLE", status: 409, code: "NOT_REPLACEABLE" },
    { kind: "CASE_TERMINAL", status: 409, code: "CASE_TERMINAL" },
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
        caseRecord: ownedCaseRecord,
        appointments: [scheduledRecoveryAppointment],
      });
      const { app } = createApp(executeUpdateWithStart, fetchImpl, {
        authenticate: officerAuth,
      });

      const response = await app.request(
        replacementRoute(recoveryCaseId, recoveryAppointmentId),
        putJson(replacementBody)
      );

      expect(response.status).toBe(outcome.status);
      expect(await response.json()).toMatchObject({
        error: { code: outcome.code, retryable: false },
      });
    });
  }

  it("returns 504 with a Retry-After while the Update is still pending, and reattaches with the same operation", async () => {
    let finishFirst: ((value: typeof replacementSuccess) => void) | undefined;
    const pending = new Promise<typeof replacementSuccess>((resolve) => {
      finishFirst = resolve;
    });
    const executeUpdateWithStart = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(replacementSuccess);
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: officerAuth,
    });
    const idempotencyKey = randomUUID();

    const timedOut = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody, idempotencyKey)
    );
    const reattached = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody, idempotencyKey)
    );

    expect(timedOut.status).toBe(504);
    expect(timedOut.headers.get("Retry-After")).toBe("2");
    expect(await timedOut.json()).toMatchObject({
      error: { code: "WORKFLOW_UPDATE_PENDING", retryable: true },
    });
    expect(reattached.status).toBe(200);
    expect(executeUpdateWithStart.mock.calls[0][1].updateId).toBe(
      executeUpdateWithStart.mock.calls[1][1].updateId
    );
    finishFirst?.(replacementSuccess);
  });

  it("returns 503 when Temporal is unavailable", async () => {
    const unavailable = Object.assign(new Error("service unavailable"), {
      code: 14,
    });
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchImpl,
      { authenticate: officerAuth }
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

  it("returns 500 when the Workflow answers with something off-contract", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [scheduledRecoveryAppointment],
    });
    const { app } = createApp(
      vi.fn().mockResolvedValue({ kind: "NOT_A_REAL_OUTCOME" }),
      fetchImpl,
      { authenticate: officerAuth }
    );

    const response = await app.request(
      replacementRoute(recoveryCaseId, recoveryAppointmentId),
      putJson(replacementBody)
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "WORKFLOW_UPDATE_FAILED", retryable: false },
    });
  });
});

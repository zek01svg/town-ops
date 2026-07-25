import { randomUUID } from "node:crypto";

import type { AppointmentDto } from "@townops/orchestration-contract";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  fetchResolving,
  officerAuth,
  successResult,
} from "./helpers";

function startWorkRoute(caseIdValue: string, appointmentIdValue: string) {
  return `/api/cases/${caseIdValue}/appointments/${appointmentIdValue}/start-work`;
}

/** The Appointment atom's list response, carrying one Appointment or none. */
function appointmentFetch(appointment: AppointmentDto | null): typeof fetch {
  return fetchResolving(
    Response.json({ appointments: appointment ? [appointment] : [] })
  );
}

describe("Gateway Contractor start-work (PRS-145)", () => {
  const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "e5e5e5e5-5555-4555-8555-555555555555",
      role: "contractor",
      contractorId,
    });
    await next();
  };
  const caseId = successResult.data.id;
  const appointmentId = "dddddddd-1111-4111-8111-111111111111";
  const assignmentId = "aaaaaaaa-1111-4111-8111-111111111111";
  const attemptId = "bbbbbbbb-1111-4111-8111-111111111111";
  const assignment = {
    id: assignmentId,
    caseId,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  const scheduledAppointment = {
    id: appointmentId,
    caseId,
    assignmentId,
    attemptId,
    contractorId,
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 60_000).toISOString(),
    status: "SCHEDULED" as const,
    reason: null,
    operationId: "accept/1/confirm",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  const inProgressAppointment = {
    ...scheduledAppointment,
    status: "IN_PROGRESS" as const,
  };
  const startWorkSuccess = {
    kind: "SUCCESS" as const,
    data: {
      appointment: inProgressAppointment,
      assignment,
      case: { ...successResult.data, status: "IN_PROGRESS" as const },
    },
  };

  it("rejects a non-Contractor before reading the Appointment", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-UUID Idempotency-Key", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const missing = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
    });
    const invalid = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": "not-a-uuid" },
    });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(invalid.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID caseId path param", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(
      startWorkRoute("not-a-uuid", appointmentId),
      {
        method: "PUT",
        headers: { "Idempotency-Key": randomUUID() },
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID appointmentId path param", async () => {
    const fetchImpl = vi.fn();
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, "not-a-uuid"), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("returns APPOINTMENT_NOT_FOUND when no Appointment matches the ID", async () => {
    const fetchImpl = appointmentFetch(null);
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("returns APPOINTMENT_NOT_FOUND when the Appointment belongs to a different Contractor", async () => {
    const fetchImpl = appointmentFetch({
      ...scheduledAppointment,
      contractorId: randomUUID(),
    });
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("maps a Worker NOT_IN_WINDOW rejection to 409 APPOINTMENT_NOT_IN_PROGRESS_WINDOW", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue({ kind: "NOT_IN_WINDOW" });
    const fetchImpl = appointmentFetch(scheduledAppointment);
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_IN_PROGRESS_WINDOW", retryable: false },
    });
  });

  it("maps a Worker NOT_SCHEDULED rejection to 409 NOT_SCHEDULED", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue({ kind: "NOT_SCHEDULED" });
    const fetchImpl = appointmentFetch(scheduledAppointment);
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_SCHEDULED", retryable: false },
    });
  });

  it("maps a Worker WRONG_CONTRACTOR rejection (post pre-check) to 404 APPOINTMENT_NOT_FOUND", async () => {
    // The pre-check passes (same Contractor owns the row); this proves the
    // Worker-returned kind, not just the Gateway's own ownership pre-check,
    // maps to the same 404 contract.
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue({ kind: "WRONG_CONTRACTOR" });
    const fetchImpl = appointmentFetch(scheduledAppointment);
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).toHaveBeenCalled();
  });

  it("starts work through Temporal and returns the IN_PROGRESS envelope on SUCCESS", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue(startWorkSuccess);
    const fetchImpl = appointmentFetch(scheduledAppointment);
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        appointment: { status: "IN_PROGRESS" },
        case: { status: "IN_PROGRESS" },
      },
      operation: { caseId },
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "startWork",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "CONTRACTOR",
            contractorId,
            caseId,
            assignmentId,
            appointmentId,
            startTime: scheduledAppointment.startTime,
            endTime: scheduledAppointment.endTime,
          }),
        ],
      })
    );
  });

  it("returns a retryable error when Temporal is unavailable", async () => {
    const unavailable = Object.assign(new Error("service unavailable"), {
      code: 14,
    });
    const fetchImpl = appointmentFetch(scheduledAppointment);
    const { app } = createApp(
      vi.fn().mockRejectedValue(unavailable),
      fetchImpl,
      { authenticate: contractorAuth }
    );

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("does not reject an already-IN_PROGRESS Appointment at the pre-check (authorization-only)", async () => {
    // The fix under test: the pre-check must be status-agnostic so a
    // same-key retry that lands after the Saga already committed still
    // reaches the Workflow's idempotency-cache replay instead of a stale 404.
    const executeUpdateWithStart = vi.fn().mockResolvedValue(startWorkSuccess);
    const fetchImpl = appointmentFetch(inProgressAppointment);
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
    });

    expect(response.status).toBe(200);
    expect(executeUpdateWithStart).toHaveBeenCalled();
  });

  it("RETRY-AFTER-AMBIGUOUS: a timed-out start-work reattaches to a cached SUCCESS instead of 404ing on the now-IN_PROGRESS Appointment", async () => {
    let finishFirst: ((value: typeof startWorkSuccess) => void) | undefined;
    const pending = new Promise<typeof startWorkSuccess>((resolve) => {
      finishFirst = resolve;
    });
    const executeUpdateWithStart = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(startWorkSuccess);
    // The pre-check reads the Appointment atom fresh on every request: still
    // SCHEDULED when the first (timed-out) request's pre-check runs, then
    // IN_PROGRESS once the Saga has actually committed by the time the
    // same-key retry's pre-check runs.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ appointments: [scheduledAppointment] })
      )
      .mockResolvedValueOnce(
        Response.json({ appointments: [inProgressAppointment] })
      );
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });
    const idempotencyKey = randomUUID();

    const timedOut = await app.request(startWorkRoute(caseId, appointmentId), {
      method: "PUT",
      headers: { "Idempotency-Key": idempotencyKey },
    });

    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({
      error: {
        code: "WORKFLOW_UPDATE_PENDING",
        retryable: true,
        operation: expect.objectContaining({ caseId }),
      },
    });

    const reattached = await app.request(
      startWorkRoute(caseId, appointmentId),
      {
        method: "PUT",
        headers: { "Idempotency-Key": idempotencyKey },
      }
    );

    expect(reattached.status).toBe(200);
    expect(await reattached.json()).toMatchObject({
      data: { appointment: { status: "IN_PROGRESS" } },
      operation: { caseId },
    });
    expect(executeUpdateWithStart.mock.calls[0][1].updateId).toBe(
      executeUpdateWithStart.mock.calls[1][1].updateId
    );
    finishFirst?.(startWorkSuccess);
  });
});

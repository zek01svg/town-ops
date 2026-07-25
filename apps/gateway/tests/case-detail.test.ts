import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createApp, officerAuth, residentAuth, successResult } from "./helpers";
import {
  ownedCaseRecord,
  recoveryAttemptId,
  recoveryCaseId,
  recoveryContractorId,
  recoveryFetch,
  replacementAppointmentId,
  scheduledRecoveryAppointment,
} from "./recovery-helpers";

describe("Case detail after allocation", () => {
  const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
  // A Contractor Account's own ID is not the Contractor ID — the linked
  // Contractor arrives as its own claim, and authorization keys off that.
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "e5e5e5e5-5555-4555-8555-555555555555",
      role: "contractor",
      contractorId,
    });
    await next();
  };
  const assignedCase = {
    ...successResult.data,
    priority: "high",
    // Allocation moves the Case out of PENDING. Reading it back must keep
    // working — a Case that has progressed is the normal case, not an edge one.
    status: "assigned",
  };
  const assignmentId = "aaaaaaaa-1111-4111-8111-111111111111";
  const assignment = {
    id: assignmentId,
    caseId: successResult.data.id,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  function attemptFor(offeredTo: string) {
    return {
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      assignmentId,
      contractorId: offeredTo,
      source: "AUTO_ASSIGN",
      status: "PENDING_ACCEPTANCE",
      acceptanceSlaMs: 60_000,
      deadlineAt: "2026-07-22T00:01:00.000Z",
      actorId: "00000000-0000-0000-0000-000000000000",
      actorRole: "SYSTEM",
      reason: null,
      operationId: "op/1",
      createdAt: "2026-07-22T00:00:00.000Z",
    };
  }

  function fetchFor(caseRecord: unknown, attempt: unknown): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      return href.includes("/api/assignments")
        ? Response.json({ assignment, attempt })
        : Response.json({ cases: [caseRecord] });
    });
  }

  it("serves an ASSIGNED Case to the Officer with its Assignment", async () => {
    const { app } = createApp(
      undefined,
      fetchFor(assignedCase, attemptFor(contractorId)),
      {}
    );

    const response = await app.request("/api/cases/" + successResult.data.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "ASSIGNED" });
  });

  it("serves an ASSIGNED Case to its owning Resident", async () => {
    const { app } = createApp(
      undefined,
      fetchFor(assignedCase, attemptFor(contractorId)),
      {
        authenticate: residentAuth,
      }
    );

    const response = await app.request("/api/cases/" + successResult.data.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { status: "ASSIGNED" },
    });
  });

  it("serves an ASSIGNED Case to the Contractor named on the pending Attempt", async () => {
    const { app } = createApp(
      undefined,
      fetchFor(assignedCase, attemptFor(contractorId)),
      {
        authenticate: contractorAuth,
      }
    );

    const response = await app.request("/api/cases/" + successResult.data.id);

    expect(response.status).toBe(200);
  });

  it("hides the Case from a Contractor it was never offered to", async () => {
    const { app } = createApp(
      undefined,
      fetchFor(
        assignedCase,
        attemptFor("d2d2d2d2-2222-4222-8222-222222222222")
      ),
      { authenticate: contractorAuth }
    );

    const response = await app.request("/api/cases/" + successResult.data.id);

    expect(response.status).toBe(404);
  });
});

describe("Case detail after a reschedule (PRS-146)", () => {
  const retiredRescheduled = {
    ...scheduledRecoveryAppointment,
    id: "11111111-2222-4222-8222-222222222222",
    status: "RESCHEDULED" as const,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  const retiredNoAccess = {
    ...scheduledRecoveryAppointment,
    id: "22222222-2222-4222-8222-222222222222",
    status: "NO_ACCESS" as const,
    createdAt: "2030-01-02T00:00:00.000Z",
  };
  const currentScheduled = {
    ...scheduledRecoveryAppointment,
    id: replacementAppointmentId,
    startTime: "2030-02-01T09:00:00.000Z",
    endTime: "2030-02-01T10:00:00.000Z",
    status: "SCHEDULED" as const,
    createdAt: "2030-01-03T00:00:00.000Z",
  };

  it("returns the newest Appointment for the Attempt even when a retired row comes first", async () => {
    // Deliberately oldest-first: a naive `.find()` over this list returns the
    // RESCHEDULED row, which is exactly the regression the sort prevents.
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [retiredRescheduled, retiredNoAccess, currentScheduled],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${recoveryCaseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.assignment.appointment).toMatchObject({
      id: replacementAppointmentId,
      status: "SCHEDULED",
    });
  });

  it("still returns the newest Appointment when the rows arrive newest-first", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [currentScheduled, retiredNoAccess, retiredRescheduled],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${recoveryCaseId}`);

    expect((await response.json()).data.assignment.appointment).toMatchObject({
      id: replacementAppointmentId,
    });
  });

  it("ignores Appointments belonging to a different Attempt", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [
        {
          ...currentScheduled,
          id: randomUUID(),
          attemptId: randomUUID(),
          createdAt: "2030-06-01T00:00:00.000Z",
        },
        currentScheduled,
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${recoveryCaseId}`);

    expect((await response.json()).data.assignment.appointment).toMatchObject({
      id: replacementAppointmentId,
    });
  });

  it("gives the owning Resident a narrowed Appointment but no Assignment or Attempt", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [retiredNoAccess, currentScheduled],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${recoveryCaseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: "ASSIGNED",
      appointment: {
        id: replacementAppointmentId,
        status: "SCHEDULED",
      },
    });
    expect(body.data.assignment).toBeUndefined();
    expect(body.data.appointment).toEqual({
      id: replacementAppointmentId,
      startTime: "2030-02-01T09:00:00.000Z",
      endTime: "2030-02-01T10:00:00.000Z",
      status: "SCHEDULED",
      reason: null,
    });
    // Only the *retired* rows stay hidden — the Resident sees one Appointment,
    // never the reschedule history.
    expect(JSON.stringify(body)).not.toContain(retiredNoAccess.id);
  });

  it("still gives an Officer the current Attempt alongside the Appointment", async () => {
    const fetchImpl = recoveryFetch({
      caseRecord: ownedCaseRecord,
      appointments: [retiredNoAccess, currentScheduled],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${recoveryCaseId}`);
    const body = await response.json();

    expect(body.data.assignment.currentAttempt).toMatchObject({
      id: recoveryAttemptId,
      contractorId: recoveryContractorId,
    });
  });
});

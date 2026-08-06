import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  officerAuth,
  residentAuth,
  residentId,
  successResult,
} from "./helpers";
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
      // The internal Case route (Officer only, PRS-151 Task 2) hands back a
      // singular `case`, not the public route's `cases` array — checked
      // first since it is otherwise a subset match of nothing else below.
      if (href.includes("/internal/cases/")) {
        return Response.json({ case: caseRecord });
      }
      // The Attempt-history route (`.../by-case/:id/attempts`, PRS-151
      // Task 1/3) is a distinct shape from the current-assignment lookup
      // below, and its URL is a superset of the latter's — checked first.
      if (
        href.includes("/api/assignments/by-case/") &&
        href.endsWith("/attempts")
      ) {
        return Response.json({ attempts: attempt ? [attempt] : [] });
      }
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

describe("Officer Case detail gains full state (PRS-151 151-D Task 1)", () => {
  const caseId = successResult.data.id;
  const assignmentId = "aaaaaaaa-3333-4333-8333-333333333333";
  const contractorId = "c3c3c3c3-1111-4111-8111-111111111111";
  const caseRecord = {
    ...successResult.data,
    id: caseId,
    priority: "high",
    status: "in_progress",
  };
  const assignment = {
    id: assignmentId,
    caseId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
  const currentAttempt = {
    id: "bbbbbbbb-3333-4333-8333-333333333333",
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
    id: "dddddddd-3333-4333-8333-333333333333",
    caseId,
    assignmentId,
    attemptId: currentAttempt.id,
    contractorId,
    startTime: "2030-01-02T09:00:00.000Z",
    endTime: "2030-01-02T10:00:00.000Z",
    status: "SCHEDULED",
    reason: null,
    operationId: "accept/1",
    createdAt: "2030-01-02T00:00:00.000Z",
  };
  const proofItem = {
    id: "eeeeeeee-3333-4333-8333-333333333333",
    caseId,
    contractorId,
    mediaUrl: "https://proof.example/officer-1",
    type: "BEFORE",
    remarks: null,
    checksum: "a".repeat(64),
    ready: true,
    createdAt: "2030-01-03T00:00:00.000Z",
  };
  const effect = {
    id: "effect-officer-1",
    caseId,
    type: "EMAIL",
    purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
    status: "SENT",
    providerId: "provider-1",
    providerIdempotencyKey: "effect-officer-1",
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    contractorId: null,
    scoreDelta: null,
    createdAt: "2030-01-04T00:00:00.000Z",
    updatedAt: "2030-01-04T00:00:00.000Z",
  };
  const attention = {
    id: "ffffffff-3333-4333-8333-333333333333",
    caseId,
    kind: "MISSED_APPOINTMENT",
    detail: "No contact at the door",
    operationId: "attn/1",
    effectId: null,
    createdAt: "2030-01-05T00:00:00.000Z",
    resolvedAt: null,
    resolvedByOperationId: null,
  };

  function fullFetch(): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/internal/cases/")) {
        return Response.json({ case: caseRecord });
      }
      if (
        href.includes("/api/assignments/by-case/") &&
        href.endsWith("/attempts")
      ) {
        return Response.json({ attempts: [currentAttempt] });
      }
      if (href.includes("/api/assignments/by-case/")) {
        return Response.json({ assignment, attempt: currentAttempt });
      }
      if (href.includes("/api/appointments/")) {
        return Response.json({ appointments: [appointment] });
      }
      if (href.includes("/internal/proof-items/")) {
        return Response.json({ proof: [proofItem] });
      }
      if (href.includes("/internal/effects/case/")) {
        return Response.json({ effects: [effect] });
      }
      if (href.includes("/api/cases/officer-attention")) {
        // The atom has no single "all" filter; only `state=open` carries a
        // row here so a bug that only ever reads one of the two merged
        // calls is still caught.
        const isResolved = href.includes("state=resolved");
        return Response.json({ attentions: isResolved ? [] : [attention] });
      }
      return Response.json({ cases: [caseRecord] });
    });
  }

  it("returns every new section — full Attempt history, Appointment history, Proof Items, Derived Effects, and case-scoped Officer Attention — each non-empty", async () => {
    const { app } = createApp(undefined, fullFetch(), {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.attempts).toHaveLength(1);
    expect(body.data.attempts[0]).toMatchObject({
      id: currentAttempt.id,
      contractorId,
    });
    expect(body.data.appointments).toHaveLength(1);
    expect(body.data.appointments[0]).toMatchObject({ id: appointment.id });
    expect(body.data.proofItems).toHaveLength(1);
    expect(body.data.proofItems[0]).toMatchObject({ id: proofItem.id });
    expect(body.data.effects).toHaveLength(1);
    expect(body.data.effects[0]).toMatchObject({ id: effect.id });
    expect(body.data.officerAttention).toHaveLength(1);
    expect(body.data.officerAttention[0]).toMatchObject({ id: attention.id });
    // The existing current-Attempt/Appointment envelope is untouched by the
    // new sections being additive, not a replacement.
    expect(body.data.assignment.currentAttempt).toMatchObject({
      id: currentAttempt.id,
    });
  });
});

describe("Officer detail reads the completion report the public route strips (PRS-151 151-D Task 2)", () => {
  const caseId = successResult.data.id;
  const reportText = "Fixed the leaking pipe under unit 4B.";
  const completionOperationId = "complete/officer-1/case";
  const proofItemId = "12121212-1212-4212-8212-121212121212";
  const completedInternalRecord = {
    ...successResult.data,
    id: caseId,
    residentId,
    status: "completed",
    completionOperationId,
    completionReport: reportText,
    completionProofItemIds: [proofItemId],
  };
  // The public route's `publicCase()` strips the three completion fields
  // entirely (not nulls them) — the mock omits the keys, the same shape the
  // real atom hands a Resident or Contractor reader.
  const {
    completionOperationId: _completionOperationId,
    completionReport: _completionReport,
    completionProofItemIds: _completionProofItemIds,
    ...publicRecord
  } = completedInternalRecord;

  const contractorId = "c4c4c4c4-1111-4111-8111-111111111111";
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "d4d4d4d4-4444-4444-8444-444444444444",
      role: "contractor",
      contractorId,
    });
    await next();
  };
  const attempt = {
    id: "b4b4b4b4-1111-4111-8111-111111111111",
    assignmentId: "a4a4a4a4-1111-4111-8111-111111111111",
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

  function fetchWith(): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/internal/cases/")) {
        return Response.json({ case: completedInternalRecord });
      }
      if (
        href.includes("/api/assignments/by-case/") &&
        href.endsWith("/attempts")
      ) {
        return Response.json({ attempts: [attempt] });
      }
      if (href.includes("/api/assignments/by-case/")) {
        return Response.json({ assignment: null, attempt: null });
      }
      if (href.includes("/api/appointments/")) {
        return Response.json({ appointments: [] });
      }
      if (href.includes("/internal/proof-items/")) {
        return Response.json({ proof: [] });
      }
      if (href.includes("/internal/effects/case/")) {
        return Response.json({ effects: [] });
      }
      if (href.includes("/api/cases/officer-attention")) {
        return Response.json({ attentions: [] });
      }
      return Response.json({ cases: [publicRecord] });
    });
  }

  it("gives the Officer the completion report, operation id, and proof item ids", async () => {
    const { app } = createApp(undefined, fetchWith(), {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.completionReport).toBe(reportText);
    expect(body.data.completionOperationId).toBe(completionOperationId);
    expect(body.data.completionProofItemIds).toEqual([proofItemId]);
  });

  it("never gives the owning Resident the completion report", async () => {
    const { app } = createApp(undefined, fetchWith(), {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("completionReport");
    expect(body.data).not.toHaveProperty("completionOperationId");
    expect(body.data).not.toHaveProperty("completionProofItemIds");
    expect(JSON.stringify(body)).not.toContain(reportText);
  });

  it("never gives the Contractor the completion report", async () => {
    const { app } = createApp(undefined, fetchWith(), {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("completionReport");
    expect(body.data).not.toHaveProperty("completionOperationId");
    expect(body.data).not.toHaveProperty("completionProofItemIds");
    expect(JSON.stringify(body)).not.toContain(reportText);
  });
});

describe("Contractor detail: current vs historical (PRS-151 151-D Task 3)", () => {
  const caseId = successResult.data.id;
  const contractorId = "c5c5c5c5-1111-4111-8111-111111111111";
  const replacementContractorId = "e5e5e5e5-2222-4222-8222-222222222222";
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "d5d5d5d5-5555-4555-8555-555555555555",
      role: "contractor",
      contractorId,
    });
    await next();
  };
  const replacementContractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "f5f5f5f5-6666-4666-8666-666666666666",
      role: "contractor",
      contractorId: replacementContractorId,
    });
    await next();
  };
  const caseResidentId = "77777777-1111-4111-8111-111111111111";
  const caseAddressDetails = "12 Secret Lane, Unit 4B";
  const casePostalCode = "654321";
  const caseRecord = {
    ...successResult.data,
    id: caseId,
    residentId: caseResidentId,
    addressDetails: caseAddressDetails,
    postalCode: casePostalCode,
    priority: "high",
    status: "assigned",
  };
  const assignmentId = "a5a5a5a5-1111-4111-8111-111111111111";
  const replacedAttempt = {
    id: "b5b5b5b5-1111-4111-8111-111111111111",
    assignmentId,
    contractorId,
    source: "AUTO_ASSIGN",
    status: "BREACHED",
    acceptanceSlaMs: 60_000,
    deadlineAt: "2030-01-01T00:01:00.000Z",
    actorId: "00000000-0000-0000-0000-000000000000",
    actorRole: "SYSTEM",
    reason: null,
    operationId: `${caseId}/allocate/${contractorId}/1`,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  const currentAttempt = {
    id: "b5b5b5b5-2222-4222-8222-222222222222",
    assignmentId,
    contractorId: replacementContractorId,
    source: "BREACH_REASSIGN",
    status: "PENDING_ACCEPTANCE",
    acceptanceSlaMs: 60_000,
    deadlineAt: "2030-01-02T00:01:00.000Z",
    actorId: "00000000-0000-0000-0000-000000000000",
    actorRole: "SYSTEM",
    reason: "SLA breach",
    // The auto-allocation operationId format (case-workflow.ts:461) embeds
    // the winning Contractor's id verbatim — the row filter must drop this
    // whole row, not just its fields, or this id leaks through it.
    operationId: `${caseId}/allocate/${replacementContractorId}/2`,
    createdAt: "2030-01-02T00:00:00.000Z",
  };
  const ownAppointment = {
    id: "d5d5d5d5-1111-4111-8111-111111111111",
    caseId,
    assignmentId,
    attemptId: replacedAttempt.id,
    contractorId,
    startTime: "2030-01-01T09:00:00.000Z",
    endTime: "2030-01-01T10:00:00.000Z",
    status: "NO_ACCESS",
    reason: null,
    operationId: "no-access/1",
    createdAt: "2030-01-01T05:00:00.000Z",
  };
  const replacementAppointment = {
    id: "d5d5d5d5-2222-4222-8222-222222222222",
    caseId,
    assignmentId,
    attemptId: currentAttempt.id,
    contractorId: replacementContractorId,
    startTime: "2030-01-03T09:00:00.000Z",
    endTime: "2030-01-03T10:00:00.000Z",
    status: "SCHEDULED",
    reason: null,
    operationId: "accept/2",
    createdAt: "2030-01-03T00:00:00.000Z",
  };
  const ownProof = {
    id: "e5e5e5e5-1111-4111-8111-111111111111",
    caseId,
    contractorId,
    mediaUrl: "https://proof.example/own",
    type: "BEFORE",
    remarks: null,
    checksum: "a".repeat(64),
    ready: true,
    createdAt: "2030-01-01T06:00:00.000Z",
  };
  const replacementProof = {
    id: "f5f5f5f5-2222-4222-8222-222222222222",
    caseId,
    contractorId: replacementContractorId,
    mediaUrl: "https://proof.example/replacement",
    type: "BEFORE",
    remarks: null,
    checksum: "b".repeat(64),
    ready: true,
    createdAt: "2030-01-03T06:00:00.000Z",
  };
  const ownEffect = {
    id: "effect-own",
    caseId,
    type: "PERFORMANCE_ENTRY",
    purpose: "ATTEMPT_BREACH_PERFORMANCE",
    status: "SENT",
    providerId: null,
    providerIdempotencyKey: "effect-own",
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    contractorId,
    scoreDelta: -5,
    createdAt: "2030-01-01T07:00:00.000Z",
    updatedAt: "2030-01-01T07:00:00.000Z",
  };
  const replacementEffect = {
    ...ownEffect,
    id: "effect-replacement",
    providerIdempotencyKey: "effect-replacement",
    contractorId: replacementContractorId,
    scoreDelta: 0,
    createdAt: "2030-01-03T07:00:00.000Z",
    updatedAt: "2030-01-03T07:00:00.000Z",
  };

  function historicalFetch(): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (
        href.includes("/api/assignments/by-case/") &&
        href.endsWith("/attempts")
      ) {
        return Response.json({ attempts: [replacedAttempt, currentAttempt] });
      }
      // The bare by-case route (no `/attempts`) backs `lookupCaseAssignment`,
      // which supplies the CURRENT Contractor's `assignment` envelope. It
      // must be matched *after* the `/attempts` branch above — this prefix
      // also matches that URL.
      if (href.includes("/api/assignments/by-case/")) {
        return Response.json({
          assignment: {
            id: assignmentId,
            caseId,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          attempt: currentAttempt,
        });
      }
      if (href.includes("/api/appointments/")) {
        return Response.json({
          appointments: [ownAppointment, replacementAppointment],
        });
      }
      if (href.includes("/internal/proof-items/")) {
        return Response.json({ proof: [ownProof, replacementProof] });
      }
      if (href.includes("/internal/effects/case/")) {
        return Response.json({ effects: [ownEffect, replacementEffect] });
      }
      return Response.json({ cases: [caseRecord] });
    });
  }

  it("gives a historical Contractor only its own rows, and never the Resident's identity, full address, or a replacement Contractor's id — including inside an operationId", async () => {
    const { app } = createApp(undefined, historicalFetch(), {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);

    // Non-vacuous: every channel the filter runs over actually has rows in
    // it, and this Contractor's own rows survive the filter.
    expect(body.data.attempts.length).toBeGreaterThan(0);
    expect(body.data.appointments.length).toBeGreaterThan(0);
    expect(body.data.proofItems.length).toBeGreaterThan(0);
    expect(body.data.effects.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toContain(contractorId);

    // The narrowed DTO (151-B): Resident identity and full address dropped,
    // `postalSector` in their place. No `officerAttention` section for a
    // Contractor at all.
    expect(body.data).not.toHaveProperty("residentId");
    expect(body.data).not.toHaveProperty("addressDetails");
    expect(body.data).not.toHaveProperty("postalCode");
    expect(body.data.postalSector).toBe("65");
    expect(body.data).not.toHaveProperty("officerAttention");

    // `assignment` is null for HISTORICAL: its `currentAttempt` belongs to
    // the replacement, so handing it over is the AC6 leak the CURRENT-only
    // scoping exists to prevent. Asserted explicitly rather than left to the
    // whole-body leak check below — a future change could populate it from
    // this Contractor's own stale Attempt and still pass that check while
    // reintroducing the wrong shape.
    expect(body.data.assignment).toBeNull();

    // The replacement Contractor's id must not survive anywhere in the
    // body — not as a field, not nested in `detail`, not embedded in an
    // `operationId` substring — nor may the Resident's identity or full
    // address.
    expect(JSON.stringify(body)).not.toContain(replacementContractorId);
    expect(JSON.stringify(body)).not.toContain(caseResidentId);
    expect(JSON.stringify(body)).not.toContain(caseAddressDetails);
  });

  it("gives the CURRENT Contractor the full CaseDto (postalCode, not postalSector), the predecessor's rows too on every section, and their own live `assignment` envelope", async () => {
    const { app } = createApp(undefined, historicalFetch(), {
      authenticate: replacementContractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);
    const body = await response.json();

    expect(response.status).toBe(200);

    // CURRENT keeps the full CaseDto — no historical narrowing.
    expect(body.data.residentId).toBe(caseResidentId);
    expect(body.data.addressDetails).toBe(caseAddressDetails);
    expect(body.data.postalCode).toBe(casePostalCode);
    expect(body.data).not.toHaveProperty("postalSector");

    // CURRENT is not row-filtered — the replaced predecessor's rows on every
    // section come through, not just this Contractor's own (the row filter
    // in `includeTimelineEventForRole` only narrows once HISTORICAL).
    expect(JSON.stringify(body)).toContain(contractorId);
    expect(JSON.stringify(body)).toContain(replacementContractorId);

    // A CURRENT Contractor keeps the `assignment` envelope: their own live
    // Attempt and Appointment. `apps/frontend/contractor/src/features/case/
    // components/case-audit-trail.tsx` (`useGatewayAssignment`,
    // `gatewayCaseSchema`) reads `data.assignment.currentAttempt`/
    // `.appointment` and gates Accept Job / Start Work / No Access /
    // Complete Job on it, so dropping it here disables every one of those
    // controls silently — 200 response, `.nullish()` schema, no error and no
    // empty state. 151-D briefly dropped it for all Contractors; the leak it
    // was closing exists only for HISTORICAL (where `currentAttempt` belongs
    // to the replacement), so the drop is scoped to that participation.
    //
    // Do not weaken this to `.toBeDefined()` — the nested shape is the
    // contract that consumer depends on, and 151-E migrates it onto the
    // `attempts`/`appointments` arrays below.
    expect(body.data.assignment).toMatchObject({
      currentAttempt: { id: expect.any(String) },
    });
    expect(body.data.assignment).toHaveProperty("appointment");
    expect(body.data.attempts.length).toBeGreaterThan(0);
    expect(body.data.appointments.length).toBeGreaterThan(0);
    expect(body.data.proofItems.length).toBeGreaterThan(0);
    expect(body.data.effects.length).toBeGreaterThan(0);
    expect(body.data).not.toHaveProperty("officerAttention");
  });
});

describe("GET /api/officer-attention caseId filter (PRS-151 151-D Task 4)", () => {
  it("forwards a caseId filter to the case atom", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ attentions: [] }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });
    const caseId = successResult.data.id;

    const response = await app.request(
      `/api/officer-attention?caseId=${caseId}`
    );

    expect(response.status).toBe(200);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).toContain(`caseId=${caseId}`);
  });

  it("omits the caseId param when none is given", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ attentions: [] }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/officer-attention");

    expect(response.status).toBe(200);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain("caseId=");
  });

  it("rejects a non-UUID caseId", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(
      "/api/officer-attention?caseId=not-a-uuid"
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/cases/:caseId/proof-items knock-on (PRS-151 151-D Task 5)", () => {
  const caseId = successResult.data.id;
  const contractorId = "c6c6c6c6-1111-4111-8111-111111111111";
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "d6d6d6d6-6666-4666-8666-666666666666",
      role: "contractor",
      contractorId,
    });
    await next();
  };

  it("returns 503 ASSIGNMENT_ATOM_UNAVAILABLE, not a wrong 404, when the assignment atom is unreachable", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/api/assignments")) throw new Error("ECONNREFUSED");
      return Response.json({ proof: [] });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/proof-items`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns 404 when the assignment atom is reachable but has no Assignment for the Case (ABSENT, not UNAVAILABLE)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/api/assignments")) {
        return Response.json({ assignment: null, attempt: null });
      }
      return Response.json({ proof: [] });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/proof-items`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });
  });

  it("returns 503 ASSIGNMENT_ATOM_UNAVAILABLE, not a wrong 404, when the assignment atom answers non-ok (distinct from a rejected fetch)", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = url instanceof Request ? url.url : String(url);
      if (href.includes("/api/assignments")) {
        return new Response("boom", { status: 500 });
      }
      return Response.json({ proof: [] });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/proof-items`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });
});

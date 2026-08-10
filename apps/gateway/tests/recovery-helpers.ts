import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { vi } from "vitest";

import { residentId, successResult } from "./helpers";

export const recoveryContractorId = "c1c1c1c1-1111-4111-8111-111111111111";
export const recoveryContractorAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "e5e5e5e5-5555-4555-8555-555555555555",
    role: "contractor",
    contractorId: recoveryContractorId,
  });
  await next();
};
/** A token the middleware accepts but whose subject cannot back an Actor. */
export const unusableTokenAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", { sub: "not-a-uuid", role: "resident" });
  await next();
};
export const recoveryCaseId = successResult.data.id;
export const recoveryAssignmentId = "aaaaaaaa-1111-4111-8111-111111111111";
export const recoveryAttemptId = "bbbbbbbb-1111-4111-8111-111111111111";
export const recoveryAppointmentId = "dddddddd-1111-4111-8111-111111111111";
export const replacementAppointmentId = "eeeeeeee-1111-4111-8111-111111111111";
export const recoveryAssignment = {
  id: recoveryAssignmentId,
  caseId: recoveryCaseId,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};
export const recoveryAttempt = {
  id: recoveryAttemptId,
  assignmentId: recoveryAssignmentId,
  contractorId: recoveryContractorId,
  source: "AUTO_ASSIGN" as const,
  status: "PENDING_ACCEPTANCE" as const,
  acceptanceSlaMs: 60_000,
  deadlineAt: "2026-07-22T00:01:00.000Z",
  actorId: "00000000-0000-0000-0000-000000000000",
  actorRole: "SYSTEM",
  reason: null,
  operationId: "op/1",
  createdAt: "2026-07-22T00:00:00.000Z",
};
export const scheduledRecoveryAppointment = {
  id: recoveryAppointmentId,
  caseId: recoveryCaseId,
  assignmentId: recoveryAssignmentId,
  attemptId: recoveryAttemptId,
  contractorId: recoveryContractorId,
  startTime: "2030-01-01T09:00:00.000Z",
  endTime: "2030-01-01T10:00:00.000Z",
  status: "SCHEDULED" as const,
  reason: null,
  operationId: "accept/1/confirm",
  createdAt: "2030-01-01T00:00:00.000Z",
};
export const ownedCaseRecord = {
  ...successResult.data,
  residentId,
  priority: "high",
  status: "assigned",
};

/**
 * Dispatches by atom, the same way `fetchFor` in case-detail.test.ts does —
 * the two PRS-146 routes read the Case atom (Resident ownership) and the
 * Appointment atom (authorization pre-check), and `GET /api/cases/:caseId`
 * reads all three.
 */
export function recoveryFetch(options: {
  caseRecord?: unknown;
  appointments?: unknown[];
  attempt?: unknown;
}): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = url instanceof Request ? url.url : String(url);
    // The internal Case route (Officer only, PRS-151 Task 2) hands back a
    // singular `case`, not the public route's `cases` array.
    if (href.includes("/internal/cases/")) {
      return Response.json({ case: options.caseRecord ?? null });
    }
    if (href.includes("/api/appointments")) {
      return Response.json({ appointments: options.appointments ?? [] });
    }
    // The Attempt-history route (`.../by-case/:id/attempts`) is a distinct
    // shape from the current-assignment lookup below, and its URL is a
    // superset of the latter's — checked first.
    if (
      href.includes("/api/assignments/by-case/") &&
      href.endsWith("/attempts")
    ) {
      const attempt = options.attempt ?? recoveryAttempt;
      return Response.json({ attempts: attempt ? [attempt] : [] });
    }
    if (href.includes("/api/assignments")) {
      return Response.json({
        assignment: recoveryAssignment,
        attempt: options.attempt ?? recoveryAttempt,
      });
    }
    return Response.json({
      cases: options.caseRecord ? [options.caseRecord] : [],
    });
  });
}

export function noAccessRoute(caseIdValue: string, appointmentIdValue: string) {
  return `/api/cases/${caseIdValue}/appointments/${appointmentIdValue}/no-access`;
}

export function replacementRoute(
  caseIdValue: string,
  appointmentIdValue: string
) {
  return `/api/cases/${caseIdValue}/appointments/${appointmentIdValue}/replacement`;
}

export const replacementBody = {
  startTime: "2030-02-01T09:00:00.000Z",
  endTime: "2030-02-01T10:00:00.000Z",
  reason: "Nobody was home",
};

export function putJson(body?: unknown, key = randomUUID()) {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createCancelCaseActivities } from "../src/activities/cancel-case";

const workerServiceToken = "a".repeat(32);

function requestHref(url: RequestInfo | URL) {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

function dependencies(fetchImpl: typeof fetch) {
  return createCancelCaseActivities({
    appointmentAtomUrl: "http://appointment-atom:5003",
    assignmentAtomUrl: "http://assignment-atom:5004",
    caseAtomUrl: "http://case-atom:5005",
    workerServiceToken,
    fetchImpl,
  });
}

describe("cancel-case activities (PRS-148)", () => {
  it("returns atom domain outcomes and maps the final Case row to the contract DTO", async () => {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const appointmentId = randomUUID();
    const actorId = randomUUID();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      if (href.includes("appointment-atom")) {
        return Response.json({
          outcome: "CANCELLED",
          appointment: {
            id: appointmentId,
            caseId,
            assignmentId,
            attemptId: randomUUID(),
            contractorId: randomUUID(),
            startTime: "2030-01-01T10:00:00.000Z",
            endTime: "2030-01-01T11:00:00.000Z",
            status: "CANCELLED",
            reason: null,
            operationId: "cancel/appointment",
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        });
      }
      if (href.includes("assignment-atom")) {
        return Response.json({ outcome: "CANCELLED" });
      }
      return Response.json({
        outcome: "CANCELLED",
        case: {
          id: caseId,
          residentId: randomUUID(),
          category: "le",
          priority: "high",
          status: "cancelled",
          description: "Broken street light",
          addressDetails: null,
          postalCode: "123456",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      });
    });
    const activities = dependencies(fetchImpl);

    await expect(
      activities.cancelScheduledAppointment({
        caseId,
        operationId: "cancel/appointment",
        changedBy: actorId,
      })
    ).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(
      activities.cancelAssignmentForCase({
        caseId,
        operationId: "cancel/assignment",
        changedBy: actorId,
        reason: "No longer needed",
      })
    ).resolves.toEqual({ outcome: "CANCELLED" });
    await expect(
      activities.cancelCase({
        caseId,
        operationId: "cancel/case",
        actorId,
        actorRole: "RESIDENT",
        reason: "No longer needed",
      })
    ).resolves.toMatchObject({
      outcome: "CANCELLED",
      case: { status: "CANCELLED" },
    });

    expect(fetchImpl.mock.calls.map(([url]) => requestHref(url))).toEqual([
      "http://appointment-atom:5003/internal/appointment-slots/cancel",
      "http://assignment-atom:5004/internal/assignments/cancel",
      `http://case-atom:5005/internal/cases/${caseId}/cancel`,
    ]);
  });

  it("throws unexpected upstream failures so Temporal retries the forward sequence", async () => {
    await expect(
      dependencies(
        vi.fn(async () => new Response("boom", { status: 500 }))
      ).cancelScheduledAppointment({
        caseId: randomUUID(),
        operationId: "cancel/appointment",
        changedBy: randomUUID(),
      })
    ).rejects.toThrow("Appointment atom request failed with 500");
  });
});

import { randomUUID } from "node:crypto";

import type { CompleteCaseCommand } from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createCompleteCaseActivities } from "../src/activities/complete-case";

const workerServiceToken = "a".repeat(32);
const contractorId = "11111111-1111-4111-8111-111111111111";

function requestHref(url: RequestInfo | URL) {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

function command(): CompleteCaseCommand {
  const caseId = randomUUID();
  const assignmentId = randomUUID();
  const appointmentId = randomUUID();
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "a".repeat(64),
    operationId: `${idempotencyKey}.${"a".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    appointmentId,
    input: {
      report: "Work completed.",
      proofItemIds: [randomUUID(), randomUUID()],
    },
  };
}

function dependencies(fetchImpl: typeof fetch) {
  return createCompleteCaseActivities({
    proofAtomUrl: "http://proof-atom:5007",
    appointmentAtomUrl: "http://appointment-atom:5003",
    assignmentAtomUrl: "http://assignment-atom:5004",
    caseAtomUrl: "http://case-atom:5005",
    metricsAtomUrl: "http://metrics-atom:5006",
    workerServiceToken,
    fetchImpl,
  });
}

function inProgressCase(caseId: string) {
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "le",
    priority: "high",
    status: "in_progress",
    description: "Broken street light",
    addressDetails: null,
    postalCode: "123456",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

function readyProof(id: string, caseId: string, type: "BEFORE" | "AFTER") {
  return {
    id,
    caseId,
    contractorId,
    mediaUrl: `https://proof.example/${id}`,
    type,
    remarks: null,
    checksum: "a".repeat(64),
    ready: true,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function completionFetch(
  input: CompleteCaseCommand,
  options: {
    caseStatus?: "in_progress" | "completed";
    caseCompletionOperationId?: string | null;
    appointmentStatus?: "IN_PROGRESS" | "COMPLETED";
    appointmentCompletionOperationId?: string | null;
    assignmentStatus?: "IN_PROGRESS" | "COMPLETED";
    assignmentCompletionOperationId?: string | null;
    proofLookupStatus?: 200 | 404;
  } = {}
) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = requestHref(url);
    if (href.includes("case-atom:5005/internal/cases")) {
      return Response.json({
        case: {
          ...inProgressCase(input.caseId),
          status: options.caseStatus ?? "in_progress",
          completionOperationId: options.caseCompletionOperationId ?? null,
        },
      });
    }
    if (href.includes("appointment-atom:5003/api/appointments")) {
      return Response.json({
        appointments: [
          {
            id: input.appointmentId,
            caseId: input.caseId,
            assignmentId: input.assignmentId,
            contractorId,
            status: options.appointmentStatus ?? "IN_PROGRESS",
          },
        ],
      });
    }
    if (href.includes("assignment-atom:5004/api/assignments/by-case")) {
      return Response.json({
        assignment: {
          id: input.assignmentId,
          caseId: input.caseId,
          contractorId: null,
          status: options.assignmentStatus ?? "IN_PROGRESS",
        },
        attempt: { assignmentId: input.assignmentId, contractorId },
      });
    }
    if (
      href.includes(
        "appointment-atom:5003/internal/appointment-slots/completion-operation"
      )
    ) {
      return Response.json({
        completionOperationId: options.appointmentCompletionOperationId ?? null,
      });
    }
    if (
      href.includes(
        "assignment-atom:5004/internal/assignments/completion-operation"
      )
    ) {
      return Response.json({
        completionOperationId: options.assignmentCompletionOperationId ?? null,
      });
    }
    if (options.proofLookupStatus === 404) {
      return new Response(null, { status: 404 });
    }
    const proofId = href.includes(input.input.proofItemIds[0])
      ? input.input.proofItemIds[0]
      : input.input.proofItemIds[1];
    return Response.json({
      proof: readyProof(
        proofId,
        input.caseId,
        proofId === input.input.proofItemIds[0] ? "BEFORE" : "AFTER"
      ),
    });
  });
}

describe("complete-case activity preflight", () => {
  it("validates Appointment and Assignment ownership/linkage before resolving proof", async () => {
    const input = command();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      if (href.includes("case-atom:5005/internal/cases")) {
        return Response.json({ case: inProgressCase(input.caseId) });
      }
      if (href.includes("appointment-atom:5003/api/appointments")) {
        return Response.json({
          appointments: [
            {
              id: input.appointmentId,
              caseId: input.caseId,
              assignmentId: input.assignmentId,
              contractorId,
              status: "IN_PROGRESS",
            },
          ],
        });
      }
      if (href.includes("assignment-atom:5004/api/assignments/by-case")) {
        return Response.json({
          assignment: {
            id: input.assignmentId,
            caseId: input.caseId,
            contractorId: null,
            status: "IN_PROGRESS",
          },
          attempt: { assignmentId: input.assignmentId, contractorId },
        });
      }
      const proofId = href.includes(input.input.proofItemIds[0])
        ? input.input.proofItemIds[0]
        : input.input.proofItemIds[1];
      return Response.json({
        proof: readyProof(
          proofId,
          input.caseId,
          proofId === input.input.proofItemIds[0] ? "BEFORE" : "AFTER"
        ),
      });
    });

    await expect(
      dependencies(fetchImpl).validateCompletion(input)
    ).resolves.toEqual({
      outcome: "READY",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("rejects an unlinked Appointment before any proof lookup or mutation", async () => {
    const input = command();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      if (href.includes("case-atom:5005/internal/cases")) {
        return Response.json({ case: inProgressCase(input.caseId) });
      }
      if (href.includes("appointment-atom:5003/api/appointments")) {
        return Response.json({
          appointments: [
            {
              id: input.appointmentId,
              caseId: input.caseId,
              assignmentId: randomUUID(),
              contractorId,
              status: "IN_PROGRESS",
            },
          ],
        });
      }
      return Response.json({
        assignment: {
          id: input.assignmentId,
          caseId: input.caseId,
          contractorId: null,
          status: "IN_PROGRESS",
        },
        attempt: { assignmentId: input.assignmentId, contractorId },
      });
    });

    await expect(
      dependencies(fetchImpl).validateCompletion(input)
    ).resolves.toEqual({
      outcome: "APPOINTMENT_MISMATCH",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        requestHref(url).includes("proof-items")
      )
    ).toBe(false);
  });

  it.each([
    ["a completed Appointment", "appointment"],
    ["a completed Assignment", "assignment"],
  ])(
    "permits partial recovery through %s only with the derived completion operation",
    async (_name, completed) => {
      const input = command();
      const fetchImpl = completionFetch(
        input,
        completed === "appointment"
          ? {
              appointmentStatus: "COMPLETED",
              appointmentCompletionOperationId: `${input.operationId}/appointment`,
            }
          : {
              assignmentStatus: "COMPLETED",
              assignmentCompletionOperationId: `${input.operationId}/assignment`,
            }
      );

      await expect(
        dependencies(fetchImpl).validateCompletion(input)
      ).resolves.toEqual({
        outcome: "READY",
      });
    }
  );

  it.each([
    ["Appointment", "appointment"],
    ["Assignment", "assignment"],
  ])(
    "rejects a completed %s claimed by another operation before resolving proof",
    async (_name, completed) => {
      const input = command();
      const fetchImpl = completionFetch(
        input,
        completed === "appointment"
          ? {
              appointmentStatus: "COMPLETED",
              appointmentCompletionOperationId: `other/${crypto.randomUUID()}`,
            }
          : {
              assignmentStatus: "COMPLETED",
              assignmentCompletionOperationId: `other/${crypto.randomUUID()}`,
            }
      );

      await expect(
        dependencies(fetchImpl).validateCompletion(input)
      ).resolves.toEqual({
        outcome: "NOT_IN_PROGRESS",
      });
      expect(
        fetchImpl.mock.calls.some(([url]) =>
          requestHref(url).includes("proof-items")
        )
      ).toBe(false);
    }
  );

  it("rejects a terminal Case completed by another operation before any downstream read", async () => {
    const input = command();
    const fetchImpl = completionFetch(input, {
      caseStatus: "completed",
      caseCompletionOperationId: `other/${crypto.randomUUID()}`,
    });

    await expect(
      dependencies(fetchImpl).validateCompletion(input)
    ).resolves.toEqual({
      outcome: "NOT_IN_PROGRESS",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "foreign", "legacy"])(
    "rejects %s Proof Items as completion-invalid without a mutation",
    async () => {
      const input = command();
      const fetchImpl = completionFetch(input, { proofLookupStatus: 404 });

      await expect(
        dependencies(fetchImpl).validateCompletion(input)
      ).resolves.toEqual({
        outcome: "COMPLETION_INVALID",
      });
      expect(
        fetchImpl.mock.calls.some(([url]) =>
          requestHref(url).includes("/complete")
        )
      ).toBe(false);
    }
  );
});

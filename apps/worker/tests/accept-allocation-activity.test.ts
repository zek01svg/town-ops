import { randomUUID } from "node:crypto";

import type { AcceptAllocationCommand } from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createAllocateContractorActivities } from "../src/activities/allocate-contractor";

function command(): AcceptAllocationCommand {
  const caseId = randomUUID();
  const assignmentId = randomUUID();
  const attemptId = randomUUID();
  const contractorId = randomUUID();
  return {
    idempotencyKey: randomUUID(),
    payloadHash: "a".repeat(64),
    operationId: `accept/${randomUUID()}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId,
    assignmentId,
    attemptId,
    input: {
      startTime: "2030-01-01T09:00:00.000Z",
      endTime: "2030-01-01T10:00:00.000Z",
    },
  };
}

const workerServiceToken = "a".repeat(32);

function dependencies(
  fetchImpl: typeof fetch,
  mintIdentityToken?: (audience: string) => Promise<string | undefined>
) {
  return createAllocateContractorActivities({
    contractorAtomUrl: "http://contractor",
    metricsAtomUrl: "http://metrics",
    assignmentAtomUrl: "http://assignment",
    appointmentAtomUrl: "http://appointment",
    caseAtomUrl: "http://case",
    workerServiceToken,
    fetchImpl,
    mintIdentityToken,
  });
}

describe("allocate-contractor activities identity header (PRS-140 Phase 5)", () => {
  it("attaches X-Serverless-Authorization alongside Authorization when a minter is injected", async () => {
    const caseId = randomUUID();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ case: { status: "pending" } }));
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");

    await dependencies(fetchImpl, mintIdentityToken).isCaseTerminal({
      caseId,
    });

    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith("http://case");
  });
});

describe("acceptAllocation activity", () => {
  it("reserves, accepts, confirms, then writes Case history", async () => {
    const input = command();
    const claimId = randomUUID();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            id: claimId,
            operationId: `${input.operationId}/reserve`,
            caseId: input.caseId,
            assignmentId: input.assignmentId,
            attemptId: input.attemptId,
            contractorId: input.contractorId,
            startTime: input.input.startTime,
            endTime: input.input.endTime,
            status: "HELD",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          outcome: "ACCEPTED",
          assignment: {
            id: input.assignmentId,
            caseId: input.caseId,
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          },
          attempt: {
            id: input.attemptId,
            assignmentId: input.assignmentId,
            contractorId: input.contractorId,
            source: "AUTO_ASSIGN",
            status: "ACCEPTED",
            acceptanceSlaMs: 60_000,
            deadlineAt: "2030-01-01T00:01:00.000Z",
            actorId: randomUUID(),
            actorRole: "SYSTEM",
            reason: null,
            operationId: "allocate/1",
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          appointment: {
            id: randomUUID(),
            caseId: input.caseId,
            assignmentId: input.assignmentId,
            attemptId: input.attemptId,
            contractorId: input.contractorId,
            startTime: input.input.startTime,
            endTime: input.input.endTime,
            status: "SCHEDULED",
            reason: null,
            operationId: `${input.operationId}/confirm`,
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ history: {} }));
    const fetchImpl = fetchMock;

    const result = await dependencies(fetchImpl).acceptAllocation(input);

    expect(result.kind).toBe("SUCCESS");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://appointment/internal/appointment-slots/reservations",
      "http://assignment/internal/assignments/allocation-attempts/acceptance",
      "http://appointment/internal/appointment-slots/confirmations",
      `http://case/internal/cases/${input.caseId}/allocation-acceptance`,
    ]);
  });

  it("releases a held slot only when Assignment permanently rejects the Attempt", async () => {
    const input = command();
    const claimId = randomUUID();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          claim: {
            id: claimId,
            operationId: `${input.operationId}/reserve`,
            caseId: input.caseId,
            assignmentId: input.assignmentId,
            attemptId: input.attemptId,
            contractorId: input.contractorId,
            startTime: input.input.startTime,
            endTime: input.input.endTime,
            status: "HELD",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ outcome: "ASSIGNMENT_NOT_PENDING" }, { status: 409 })
      )
      .mockResolvedValueOnce(Response.json({ outcome: "RELEASED" }));
    const fetchImpl = fetchMock;

    await expect(
      dependencies(fetchImpl).acceptAllocation(input)
    ).resolves.toEqual({
      kind: "ASSIGNMENT_NOT_PENDING",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://appointment/internal/appointment-slots/reservations",
      "http://assignment/internal/assignments/allocation-attempts/acceptance",
      "http://appointment/internal/appointment-slots/releases",
    ]);
  });

  it("returns a permanent validation result when the slot becomes past", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "Appointment slot must be in the future" },
          { status: 400 }
        )
      );

    await expect(
      dependencies(fetchMock).acceptAllocation(command())
    ).resolves.toEqual({ kind: "APPOINTMENT_NOT_FUTURE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

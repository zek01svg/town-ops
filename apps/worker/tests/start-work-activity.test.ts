import { randomUUID } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import type {
  MarkAssignmentInProgressInput,
  MarkCaseInProgressInput,
  StartWorkAppointmentInput,
} from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createStartWorkActivities } from "../src/activities/start-work";

const workerServiceToken = "a".repeat(32);

function dependencies(
  fetchImpl: typeof fetch,
  mintIdentityToken?: (audience: string) => Promise<string | undefined>
) {
  return createStartWorkActivities({
    appointmentAtomUrl: "http://appointment-atom:5003",
    assignmentAtomUrl: "http://assignment-atom:5004",
    caseAtomUrl: "http://case-atom:5005",
    workerServiceToken,
    fetchImpl,
    mintIdentityToken,
  });
}

describe("startWorkAppointment activity", () => {
  const input: StartWorkAppointmentInput = {
    operationId: `${randomUUID()}/appointment`,
    appointmentId: randomUUID(),
    contractorId: randomUUID(),
  };

  it("parses a 201 STARTED response and posts to the appointment atom", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "STARTED",
          appointment: {
            id: input.appointmentId,
            caseId: randomUUID(),
            assignmentId: randomUUID(),
            attemptId: randomUUID(),
            contractorId: input.contractorId,
            startTime: "2030-01-01T09:00:00.000Z",
            endTime: "2030-01-01T10:00:00.000Z",
            status: "IN_PROGRESS",
            reason: null,
            operationId: input.operationId,
            createdAt: "2030-01-01T09:00:00.000Z",
          },
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).startWorkAppointment(input)
    ).resolves.toMatchObject({ outcome: "STARTED" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://appointment-atom:5003/internal/appointment-slots/start-work",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerServiceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    );
  });

  it("attaches X-Serverless-Authorization alongside Authorization when a minter is injected (PRS-140 Phase 5)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ outcome: "WRONG_CONTRACTOR" }, { status: 409 })
      );
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");

    await dependencies(fetchImpl, mintIdentityToken).startWorkAppointment(
      input
    );

    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith(
      "http://appointment-atom:5003"
    );
  });

  it("parses a 409 WRONG_CONTRACTOR domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "WRONG_CONTRACTOR" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).startWorkAppointment(input)
    ).resolves.toEqual({ outcome: "WRONG_CONTRACTOR" });
  });

  it("parses a 404 APPOINTMENT_NOT_FOUND domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "APPOINTMENT_NOT_FOUND" }, { status: 404 })
      );

    await expect(
      dependencies(fetchImpl).startWorkAppointment(input)
    ).resolves.toEqual({ outcome: "APPOINTMENT_NOT_FOUND" });
  });

  it("throws a non-retryable ApplicationFailure on an unrecognized 4xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "bad request" }, { status: 400 })
      );

    const failure = await dependencies(fetchImpl)
      .startWorkAppointment(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure)) {
      throw new Error("expected an ApplicationFailure");
    }
    expect(failure.nonRetryable).toBe(true);
  });

  it("throws a retryable error on a 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }));

    await expect(
      dependencies(fetchImpl).startWorkAppointment(input)
    ).rejects.toThrow(/failed with 503/);
  });
});

describe("markAssignmentInProgress activity", () => {
  const input: MarkAssignmentInProgressInput = {
    operationId: `${randomUUID()}/assignment`,
    assignmentId: randomUUID(),
    changedBy: randomUUID(),
  };

  it("parses a 201 IN_PROGRESS response and posts to the assignment atom", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "IN_PROGRESS",
          assignment: {
            id: input.assignmentId,
            caseId: randomUUID(),
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          },
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).markAssignmentInProgress(input)
    ).resolves.toMatchObject({ outcome: "IN_PROGRESS" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://assignment-atom:5004/internal/assignments/start-work",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("parses a 409 NOT_ACCEPTED domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "NOT_ACCEPTED" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).markAssignmentInProgress(input)
    ).resolves.toEqual({ outcome: "NOT_ACCEPTED" });
  });
});

describe("markCaseInProgress activity", () => {
  const input: MarkCaseInProgressInput = {
    caseId: randomUUID(),
    operationId: `${randomUUID()}/case`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
  };

  it("uppercases the atom's lowercase category/priority/status the same way open-case.ts does", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "IN_PROGRESS",
          case: {
            id: input.caseId,
            residentId: randomUUID(),
            category: "le",
            priority: "high",
            status: "in_progress",
            description: "Broken street light",
            addressDetails: null,
            postalCode: "123456",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          },
        },
        { status: 201 }
      )
    );

    const result = await dependencies(fetchImpl).markCaseInProgress(input);
    expect(result).toMatchObject({
      outcome: "IN_PROGRESS",
      case: { category: "LE", priority: "HIGH", status: "IN_PROGRESS" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://case-atom:5005/internal/cases/${input.caseId}/start-work`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("parses a 409 CASE_TERMINAL domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "CASE_TERMINAL" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).markCaseInProgress(input)
    ).resolves.toEqual({ outcome: "CASE_TERMINAL" });
  });
});

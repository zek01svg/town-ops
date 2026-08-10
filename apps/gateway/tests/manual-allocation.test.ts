import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createApp, officerId, residentAuth, successResult } from "./helpers";

const manualAllocationResult = {
  kind: "SUCCESS" as const,
  data: {
    assignment: {
      id: "7ed5b7cc-b070-4e72-86b5-123456789abc",
      caseId: successResult.data.id,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
    attempt: {
      id: "8ed5b7cc-b070-4e72-86b5-123456789abc",
      assignmentId: "7ed5b7cc-b070-4e72-86b5-123456789abc",
      contractorId: "9ed5b7cc-b070-4e72-86b5-123456789abc",
      source: "MANUAL_ASSIGN" as const,
      status: "PENDING_ACCEPTANCE" as const,
      acceptanceSlaMs: 60_000,
      deadlineAt: "2026-07-22T00:01:00.000Z",
      actorId: officerId,
      actorRole: "OFFICER",
      reason: null,
      operationId: "manual-allocation-operation",
      createdAt: "2026-07-22T00:00:00.000Z",
    },
  },
};

describe("Gateway manual allocation and Officer Attention", () => {
  it("submits an Officer allocation through the existing Case Workflow", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue(manualAllocationResult);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ cases: [successResult.data] }));
    const { app } = createApp(executeUpdateWithStart, fetchImpl);

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          contractorId: manualAllocationResult.data.attempt.contractorId,
        }),
      }
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { attempt: { source: "MANUAL_ASSIGN" } },
      operation: { caseId: successResult.data.id },
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "allocateContractor",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            caseId: successResult.data.id,
            actorId: officerId,
            actorRole: "OFFICER",
          }),
        ],
      })
    );
  });

  it("maps OVERRIDE_REASON_REQUIRED to 400 when an Officer reuses a breached Contractor without a reason (PRS-144 AC6)", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue({ kind: "OVERRIDE_REASON_REQUIRED" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ cases: [successResult.data] }));
    const { app } = createApp(executeUpdateWithStart, fetchImpl);

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          contractorId: manualAllocationResult.data.attempt.contractorId,
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "OVERRIDE_REASON_REQUIRED", retryable: false },
    });
  });

  it("returns the Case-owned open Officer Attention list only to Officers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        attentions: [
          {
            id: "1ed5b7cc-b070-4e72-86b5-123456789abc",
            caseId: successResult.data.id,
            kind: "NO_ELIGIBLE_CONTRACTOR",
            detail: "No eligible Contractor covers this Case.",
            operationId: "case/attention/no-candidate",
            createdAt: "2026-07-22T00:00:00.000Z",
            resolvedAt: null,
            resolvedByOperationId: null,
          },
        ],
      })
    );
    const { app } = createApp(undefined, fetchImpl);

    const response = await app.request("/api/officer-attention");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { items: [{ kind: "NO_ELIGIBLE_CONTRACTOR" }] },
    });
  });

  it("rejects a Resident before reading Officer Attention", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request("/api/officer-attention");

    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

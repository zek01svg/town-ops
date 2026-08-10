import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  fetchResolving,
  officerId,
  residentAuth,
  successResult,
} from "./helpers";

const caseId = successResult.data.id;
const effect = {
  id: "attempt-1/assignment-notification",
  caseId,
  type: "EMAIL" as const,
  purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION" as const,
  status: "UNKNOWN" as const,
  providerId: null,
  providerIdempotencyKey: "attempt-1/assignment-notification",
  attempts: 3,
  lastError: "provider timeout",
  nextRetryAt: null,
  waiverActorId: null,
  waiverReason: null,
  contractorId: null,
  scoreDelta: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

describe("Gateway derived-effect repair routes (PRS-150)", () => {
  it("keeps effect summaries Officer-only", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/effects`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns an Officer's sanitized effect summaries from the Alert atom", async () => {
    const { app } = createApp(
      undefined,
      fetchResolving(Response.json({ effects: [effect] }))
    );

    const response = await app.request(`/api/cases/${caseId}/effects`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { items: [effect] } });
  });

  it("forwards an UNKNOWN retry without acknowledgement to the Officer workflow and reports its required acknowledgement", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "DUPLICATE_RISK_ACKNOWLEDGEMENT_REQUIRED",
    });
    const { app } = createApp(executeUpdateWithStart);

    const response = await app.request(
      `/api/cases/${caseId}/effects/${encodeURIComponent(effect.id)}/retry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ acknowledgeDuplicateRisk: false }),
      }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "DUPLICATE_RISK_ACKNOWLEDGEMENT_REQUIRED" },
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "retryEffect",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "OFFICER",
            caseId,
            effectId: effect.id,
            input: { acknowledgeDuplicateRisk: false },
          }),
        ],
      })
    );
  });

  it("returns the repaired effect and operation metadata after a successful retry", async () => {
    const succeededEffect = {
      ...effect,
      status: "PENDING" as const,
      lastError: null,
    };
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "SUCCESS",
      effect: succeededEffect,
    });
    const { app } = createApp(executeUpdateWithStart);

    const response = await app.request(
      `/api/cases/${caseId}/effects/${encodeURIComponent(effect.id)}/retry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(succeededEffect);
    expect(body.operation).toMatchObject({
      caseId,
      idempotencyKey: expect.any(String),
      updateId: expect.any(String),
      workflowId: expect.any(String),
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "retryEffect",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "OFFICER",
            caseId,
            effectId: effect.id,
            input: { acknowledgeDuplicateRisk: true },
          }),
        ],
      })
    );
  });

  it("returns the waived effect and operation metadata after a successful waiver", async () => {
    const waivedEffect = {
      ...effect,
      status: "WAIVED" as const,
      waiverActorId: officerId,
      waiverReason: "Resident confirmed by phone",
    };
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "SUCCESS",
      effect: waivedEffect,
    });
    const { app } = createApp(executeUpdateWithStart);

    const response = await app.request(
      `/api/cases/${caseId}/effects/${encodeURIComponent(effect.id)}/waive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ reason: "Resident confirmed by phone" }),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(waivedEffect);
    expect(body.operation).toMatchObject({
      caseId,
      idempotencyKey: expect.any(String),
      updateId: expect.any(String),
      workflowId: expect.any(String),
    });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "waiveEffect",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "OFFICER",
            caseId,
            effectId: effect.id,
            input: { reason: "Resident confirmed by phone" },
          }),
        ],
      })
    );
  });

  it("rejects an empty waiver reason before calling the workflow", async () => {
    const executeUpdateWithStart = vi.fn();
    const { app } = createApp(executeUpdateWithStart);

    const response = await app.request(
      `/api/cases/${caseId}/effects/${encodeURIComponent(effect.id)}/waive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ reason: "   " }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });
});

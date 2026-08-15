import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createDerivedEffectActivities } from "../src/activities/derived-effects";

const workerServiceToken = "a".repeat(32);

function dependencies(
  fetchImpl: typeof fetch,
  mintIdentityToken?: (audience: string) => Promise<string | undefined>
) {
  return createDerivedEffectActivities({
    alertAtomUrl: "http://alert-atom:5002",
    residentAtomUrl: "http://resident-atom:5008",
    contractorAtomUrl: "http://contractor-atom:5009",
    metricsAtomUrl: "http://metrics-atom:5006",
    caseAtomUrl: "http://case-atom:5005",
    workerServiceToken,
    fetchImpl,
    mintIdentityToken,
  });
}

function effectRow(id: string) {
  return {
    id,
    caseId: randomUUID(),
    type: "PERFORMANCE_ENTRY" as const,
    purpose: "ATTEMPT_BREACH_PERFORMANCE" as const,
    status: "PENDING" as const,
    providerId: null,
    providerIdempotencyKey: id,
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    contractorId: randomUUID(),
    scoreDelta: -10,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("derived-effect activities identity header (PRS-140 Phase 5)", () => {
  it("attaches X-Serverless-Authorization alongside Authorization when a minter is injected", async () => {
    const effectId = `${randomUUID()}/breach-performance`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ effect: effectRow(effectId) }, { status: 200 })
      );
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");

    await dependencies(fetchImpl, mintIdentityToken).reserveEffect({
      id: effectId,
      caseId: randomUUID(),
      type: "PERFORMANCE_ENTRY",
      purpose: "ATTEMPT_BREACH_PERFORMANCE",
      contractorId: randomUUID(),
      scoreDelta: -10,
      reason: "Missed acceptance SLA",
    });

    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith("http://alert-atom:5002");
  });

  it("skips the header when the minter returns nothing", async () => {
    const effectId = `${randomUUID()}/breach-performance`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ effect: effectRow(effectId) }, { status: 200 })
      );

    await dependencies(fetchImpl).reserveEffect({
      id: effectId,
      caseId: randomUUID(),
      type: "PERFORMANCE_ENTRY",
      purpose: "ATTEMPT_BREACH_PERFORMANCE",
      contractorId: randomUUID(),
      scoreDelta: -10,
      reason: "Missed acceptance SLA",
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers(init?.headers).has("X-Serverless-Authorization")).toBe(
      false
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${workerServiceToken}`
    );
  });
});

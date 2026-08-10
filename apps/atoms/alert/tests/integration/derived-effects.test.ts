import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import db from "../../src/database/db";
import { derivedEffects } from "../../src/database/schema";
import {
  beginEffect,
  EffectUnknownNotEligibleError,
  failEffect,
  markEffectUnknown,
  reserveEffect,
  retryEffect,
  succeedEffect,
  waiveEffect,
} from "../../src/service";

const caseId = "123e4567-e89b-12d3-a456-426614174000";

function emailEffect(id: string) {
  return {
    id,
    caseId,
    type: "EMAIL" as const,
    purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION" as const,
    payload: {
      type: "EMAIL" as const,
      to: "contractor@example.com",
      subject: "TownOps: Job Assigned",
      html: "<p>Original</p>",
    },
  };
}

function performanceEffect(id: string) {
  return {
    id,
    caseId,
    type: "PERFORMANCE_ENTRY" as const,
    purpose: "ATTEMPT_BREACH_PERFORMANCE" as const,
    payload: {
      type: "PERFORMANCE_ENTRY" as const,
      contractorId: "223e4567-e89b-12d3-a456-426614174002",
      scoreDelta: -5,
      reason: "ACCEPTANCE_SLA_BREACH",
    },
  };
}

async function backdateCreatedAt(id: string, hoursAgo: number) {
  await db
    .update(derivedEffects)
    .set({
      createdAt: new Date(Date.now() - hoursAgo * 60 * 60_000).toISOString(),
    })
    .where(eq(derivedEffects.id, id));
}

describe("Derived effect ledger (PRS-150)", () => {
  it("reserveEffect is idempotent — an identical payload replay returns the original reservation", async () => {
    const effect = emailEffect(
      `derived-effects-test/idempotent/${crypto.randomUUID()}`
    );

    const first = await reserveEffect(effect);
    const replay = await reserveEffect(effect);

    expect(replay).toEqual(first);
    const rows = await db
      .select()
      .from(derivedEffects)
      .where(eq(derivedEffects.id, effect.id));
    expect(rows).toHaveLength(1);
  });

  it("succeedEffect records the provider ID and moves PENDING to SENT", async () => {
    const effect = emailEffect(
      `derived-effects-test/succeed/${crypto.randomUUID()}`
    );
    await reserveEffect(effect);

    const updated = await succeedEffect(effect.id, "provider-123");

    expect(updated).toMatchObject({
      status: "SENT",
      providerId: "provider-123",
    });
  });

  it("failEffect sets FAILED, stores lastError, and persists nextRetryAt", async () => {
    const effect = emailEffect(
      `derived-effects-test/fail/${crypto.randomUUID()}`
    );
    await reserveEffect(effect);
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();

    const updated = await failEffect(
      effect.id,
      "provider unavailable",
      nextRetryAt
    );

    expect(updated?.status).toBe("FAILED");
    expect(updated?.lastError).toBe("provider unavailable");
    expect(updated?.nextRetryAt).toEqual(expect.any(String));
    expect(Date.parse(updated?.nextRetryAt ?? "")).toBe(
      Date.parse(nextRetryAt)
    );
  });

  describe("markEffectUnknown eligibility", () => {
    it("rejects a PERFORMANCE_ENTRY effect", async () => {
      const effect = performanceEffect(
        `derived-effects-test/unknown-performance/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await beginEffect(effect.id);

      await expect(markEffectUnknown(effect.id)).rejects.toBeInstanceOf(
        EffectUnknownNotEligibleError
      );
    });

    it("rejects an EMAIL effect inside the 24h idempotency window", async () => {
      const effect = emailEffect(
        `derived-effects-test/unknown-recent/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await beginEffect(effect.id);

      await expect(markEffectUnknown(effect.id)).rejects.toBeInstanceOf(
        EffectUnknownNotEligibleError
      );
    });

    it("succeeds for an EMAIL effect older than 24h with attempts > 0", async () => {
      const effect = emailEffect(
        `derived-effects-test/unknown-eligible/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await beginEffect(effect.id);
      await backdateCreatedAt(effect.id, 25);

      const updated = await markEffectUnknown(effect.id);

      expect(updated?.status).toBe("UNKNOWN");
    });
  });

  describe("waiveEffect", () => {
    it("records waiverActorId and waiverReason", async () => {
      const effect = emailEffect(
        `derived-effects-test/waive/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);

      const updated = await waiveEffect({
        id: effect.id,
        actorId: "223e4567-e89b-12d3-a456-426614174099",
        reason: "Resident confirmed by phone",
      });

      expect(updated).toMatchObject({
        status: "WAIVED",
        waiverActorId: "223e4567-e89b-12d3-a456-426614174099",
        waiverReason: "Resident confirmed by phone",
      });
    });

    it("is a no-op on an already-SENT effect", async () => {
      const effect = emailEffect(
        `derived-effects-test/waive-sent/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await succeedEffect(effect.id, "provider-123");

      const updated = await waiveEffect({
        id: effect.id,
        actorId: "223e4567-e89b-12d3-a456-426614174099",
        reason: "Resident confirmed by phone",
      });

      expect(updated?.status).toBe("SENT");
      expect(updated?.waiverActorId).toBeNull();
    });
  });

  describe("retryEffect", () => {
    it("requires the duplicate-risk acknowledgement for an UNKNOWN effect", async () => {
      const effect = emailEffect(
        `derived-effects-test/retry-unknown/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await beginEffect(effect.id);
      await backdateCreatedAt(effect.id, 25);
      await markEffectUnknown(effect.id);

      const refused = await retryEffect(effect.id, false);
      expect(refused).toEqual({ kind: "ACK_REQUIRED" });

      const acknowledged = await retryEffect(effect.id, true);
      expect(acknowledged.kind).toBe("SUCCESS");
    });

    it("refuses a SENT effect as NOT_REPAIRABLE", async () => {
      const effect = emailEffect(
        `derived-effects-test/retry-sent/${crypto.randomUUID()}`
      );
      await reserveEffect(effect);
      await succeedEffect(effect.id, "provider-123");

      const result = await retryEffect(effect.id, true);

      expect(result).toEqual({ kind: "NOT_REPAIRABLE" });
    });
  });
});

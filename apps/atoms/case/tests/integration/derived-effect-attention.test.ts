import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type CaseDb from "../../src/database/db";
import type {
  cases as CasesTable,
  officerAttention as OfficerAttentionTable,
} from "../../src/database/schema";
import type * as CaseServiceModule from "../../src/service";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

let db: CaseDb;
let cases: CasesTable;
let officerAttention: OfficerAttentionTable;
let caseService: typeof CaseServiceModule;

const CASE_ID = "123e4567-e89b-12d3-a456-426614174201";
const RESIDENT_ID = "123e4567-e89b-12d3-a456-426614174202";

describe("Derived effect attention (PRS-150)", () => {
  beforeAll(async () => {
    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");

    db = dbModule.default;
    cases = schemaModule.cases;
    officerAttention = schemaModule.officerAttention;
    caseService = await import("../../src/service");
  });

  beforeEach(async () => {
    // Scoped to this file's own CASE_ID — the case atom's integration suite
    // shares a single Testcontainer DB across files with no per-file
    // isolation (see officer-attention.test.ts). officer_attention cascades
    // on cases.id delete, so this fully resets this file's own state.
    await db.delete(cases).where(eq(cases.id, CASE_ID));
    await db.insert(cases).values({
      id: CASE_ID,
      residentId: RESIDENT_ID,
      category: "LE",
      status: "in_progress",
    });
  });

  async function findAttention() {
    return db
      .select()
      .from(officerAttention)
      .where(eq(officerAttention.caseId, CASE_ID));
  }

  it("keeps two DERIVED_EFFECT_UNKNOWN rows open at once for different effects on the same Case (officer_attention_open_effect_idx)", async () => {
    const firstEffectId = `${CASE_ID}/effect/one`;
    const secondEffectId = `${CASE_ID}/effect/two`;

    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect one was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/one`,
      effectId: firstEffectId,
    });
    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect two was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/two`,
      effectId: secondEffectId,
    });

    const records = await findAttention();
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.resolvedAt === null)).toBe(true);
    expect(new Set(records.map((record) => record.effectId))).toEqual(
      new Set([firstEffectId, secondEffectId])
    );
  });

  it("is idempotent for the same Case and effect — a repeat raise returns the existing open row", async () => {
    const effectId = `${CASE_ID}/effect/one`;

    const first = await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect one was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/one`,
      effectId,
    });
    const replay = await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect one was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/one-replay`,
      effectId,
    });

    expect(replay.id).toBe(first.id);
    const records = await findAttention();
    expect(records).toHaveLength(1);
  });

  it("still limits a non-effect kind to one open row per Case (officer_attention_open_case_kind_idx)", async () => {
    const first = await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "COMPLETION_FAILED",
      detail: "Completion validation failed.",
      operationId: `${CASE_ID}/completion-failed/one`,
    });
    const replay = await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "COMPLETION_FAILED",
      detail: "Completion validation failed.",
      operationId: `${CASE_ID}/completion-failed/two`,
    });

    expect(replay.id).toBe(first.id);
    const records = await findAttention();
    expect(records).toHaveLength(1);
    expect(records[0]?.effectId).toBeNull();

    // raiseOfficerAttention short-circuits on its own SELECT before it ever
    // inserts a second row, so the assertions above never touch the index.
    // Insert directly to prove officer_attention_open_case_kind_idx (and its
    // effect_id IS NULL predicate) itself still rejects a second open row.
    await expect(
      db.insert(officerAttention).values({
        caseId: CASE_ID,
        kind: "COMPLETION_FAILED",
        detail: "Completion validation failed.",
        operationId: `${CASE_ID}/completion-failed/direct`,
      })
    ).rejects.toThrow();
  });

  it("resolves only the row matching the given effectId, leaving a sibling effect's attention open", async () => {
    const resolvedEffectId = `${CASE_ID}/effect/resolved`;
    const openEffectId = `${CASE_ID}/effect/still-open`;

    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect resolved was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/resolved`,
      effectId: resolvedEffectId,
    });
    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "DERIVED_EFFECT_UNKNOWN",
      detail:
        "Derived effect still-open was not confirmed within the idempotency window.",
      operationId: `${CASE_ID}/effect-attention/still-open`,
      effectId: openEffectId,
    });

    await caseService.resolveDerivedEffectAttention({
      caseId: CASE_ID,
      effectId: resolvedEffectId,
      operationId: `${CASE_ID}/effect-attention/resolved/repair`,
    });

    const records = await findAttention();
    expect(records).toHaveLength(2);
    const resolved = records.find(
      (record) => record.effectId === resolvedEffectId
    );
    const stillOpen = records.find(
      (record) => record.effectId === openEffectId
    );
    expect(resolved?.resolvedAt).toEqual(expect.any(String));
    expect(stillOpen?.resolvedAt).toBeNull();
  });
});

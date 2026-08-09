import type { RecordPerformanceEntryInput } from "@townops/orchestration-contract";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let db: typeof import("../../src/database/db").default;
let performanceEntries: typeof import("../../src/database/schema").performanceEntries;
let app: typeof import("../../src/index").app;
let service: typeof import("../../src/service");
let eq: typeof import("drizzle-orm").eq;

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

function entryInput(
  overrides: Partial<RecordPerformanceEntryInput> = {}
): RecordPerformanceEntryInput {
  return {
    effectId: `${crypto.randomUUID()}/acceptance-sla-breach`,
    contractorId: crypto.randomUUID(),
    scoreDelta: -10,
    reason: "ACCEPTANCE_SLA_BREACH",
    ...overrides,
  };
}

describe("Metrics Atom Integration Tests", () => {
  beforeAll(async () => {
    console.log(
      "TEST RUNNER process.env.DATABASE_URL:",
      process.env.DATABASE_URL
    );

    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");
    const serviceModule = await import("../../src/service");
    const drizzleModule = await import("drizzle-orm");

    db = dbModule.default;
    performanceEntries = schemaModule.performanceEntries;
    app = appModule.app;
    service = serviceModule;
    eq = drizzleModule.eq;
  });

  beforeEach(async () => {
    // Clean up between tests to guarantee isolation
    await db.delete(performanceEntries);
  });

  describe("GET /health", () => {
    it("should return healthy", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "healthy" });
    });
  });

  /**
   * PRS-144: `recordPerformanceEntry`'s whole idempotency guarantee is the
   * unique `effect_id` index — a duplicate insert (replay, duplicate timer
   * delivery, or a genuine race) must always converge on exactly one row.
   * Folded into this file (rather than a separate one) since integration
   * test files in this atom share one Testcontainer DB with no per-file
   * isolation, and a second file's blanket `beforeEach` delete was observed
   * to race this file's own inserts when run together.
   */
  describe("Performance entry effect-ID dedupe (PRS-144)", () => {
    it("inserts one row for a new effect ID", async () => {
      const input = entryInput();
      const entry = await service.recordPerformanceEntry(input);

      expect(entry.contractorId).toBe(input.contractorId);
      expect(entry.scoreDelta).toBe(-10);
      expect(entry.effectId).toBe(input.effectId);

      const rows = await db
        .select()
        .from(performanceEntries)
        .where(eq(performanceEntries.effectId, input.effectId));
      expect(rows).toHaveLength(1);
    });

    it("a sequential replay of the same effect ID returns the original row and writes nothing new", async () => {
      const input = entryInput();
      const first = await service.recordPerformanceEntry(input);
      const replay = await service.recordPerformanceEntry(input);

      expect(replay.id).toBe(first.id);

      const rows = await db
        .select()
        .from(performanceEntries)
        .where(eq(performanceEntries.effectId, input.effectId));
      expect(rows).toHaveLength(1);
    });

    it("a concurrent duplicate delivery of the same effect ID still converges on exactly one row", async () => {
      const input = entryInput();

      const [a, b] = await Promise.all([
        service.recordPerformanceEntry(input),
        service.recordPerformanceEntry(input),
      ]);
      expect(a.id).toBe(b.id);

      const rows = await db
        .select()
        .from(performanceEntries)
        .where(eq(performanceEntries.effectId, input.effectId));
      expect(rows).toHaveLength(1);
    });

    it("different effect IDs each get their own row", async () => {
      const first = entryInput();
      const second = entryInput();
      await service.recordPerformanceEntry(first);
      await service.recordPerformanceEntry(second);

      const firstRows = await db
        .select()
        .from(performanceEntries)
        .where(eq(performanceEntries.effectId, first.effectId));
      const secondRows = await db
        .select()
        .from(performanceEntries)
        .where(eq(performanceEntries.effectId, second.effectId));
      expect(firstRows).toHaveLength(1);
      expect(secondRows).toHaveLength(1);
      expect(firstRows[0].id).not.toBe(secondRows[0].id);
    });

    describe("POST /internal/performance/entries", () => {
      it("requires the Worker service token", async () => {
        const res = await app.request("/internal/performance/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entryInput()),
        });
        expect(res.status).toBe(401);
      });

      it("201s a fresh entry and 201s the replay without a second row", async () => {
        const input = entryInput();
        const headers = {
          Authorization: `Bearer ${"a".repeat(32)}`,
          "Content-Type": "application/json",
        };

        const first = await app.request("/internal/performance/entries", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        expect(first.status).toBe(201);
        const firstBody = await first.json();
        expect(firstBody.entry.effectId).toBe(input.effectId);

        const replay = await app.request("/internal/performance/entries", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        expect(replay.status).toBe(201);
        const replayBody = await replay.json();
        expect(replayBody.entry.id).toBe(firstBody.entry.id);

        const rows = await db
          .select()
          .from(performanceEntries)
          .where(eq(performanceEntries.effectId, input.effectId));
        expect(rows).toHaveLength(1);
      });
    });
  });
});

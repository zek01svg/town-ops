import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

let db: typeof import("../../src/database/db").default;
let cases: typeof import("../../src/database/schema").cases;
let officerAttention: typeof import("../../src/database/schema").officerAttention;
let caseService: typeof import("../../src/service");
let app: typeof import("../../src/index").app;

const CASE_ID = "123e4567-e89b-12d3-a456-426614174101";
const RESIDENT_ID = "123e4567-e89b-12d3-a456-426614174102";
const ACTOR_ID = "123e4567-e89b-12d3-a456-426614174103";
const workerHeaders = { Authorization: `Bearer ${"a".repeat(32)}` };

describe("Officer Attention persistence", () => {
  beforeAll(async () => {
    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");
    const appModule = await import("../../src/index");

    db = dbModule.default;
    cases = schemaModule.cases;
    officerAttention = schemaModule.officerAttention;
    caseService = await import("../../src/service");
    app = appModule.app;
  });

  beforeEach(async () => {
    // Scoped to this file's own CASE_ID, not a blanket table delete —
    // case.test.ts runs concurrently against the same shared Testcontainer
    // DB (integration files have no per-file isolation here) and uses
    // randomUUID() case IDs, so a blanket delete intermittently wiped its
    // in-flight rows out from under it. officer_attention cascades on
    // cases.id delete, so this still fully resets this file's own state.
    await db.delete(cases).where(eq(cases.id, CASE_ID));
    await db.insert(cases).values({
      id: CASE_ID,
      residentId: RESIDENT_ID,
      category: "LE",
      status: "pending",
    });
  });

  async function raiseNoEligibleContractorAttention(operationId: string) {
    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "NO_ELIGIBLE_CONTRACTOR",
      detail: "No eligible contractor covers this Case.",
      operationId,
    });
  }

  async function raiseAllocationFailedAttention(operationId: string) {
    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "ALLOCATION_FAILED",
      detail: "The allocation activity failed.",
      operationId,
    });
  }

  async function raiseMissedAppointmentAttention(operationId: string) {
    await caseService.raiseOfficerAttention({
      caseId: CASE_ID,
      kind: "MISSED_APPOINTMENT",
      detail: "Appointment ended without work start, No Access, or Reschedule.",
      operationId,
    });
  }

  async function findAttention() {
    return db
      .select()
      .from(officerAttention)
      .where(eq(officerAttention.caseId, CASE_ID));
  }

  it("keeps exactly one unresolved no-candidate attention when it is raised repeatedly", async () => {
    await raiseNoEligibleContractorAttention("case/attention/no-candidate/1");
    await raiseNoEligibleContractorAttention("case/attention/no-candidate/2");

    const records = await findAttention();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      caseId: CASE_ID,
      kind: "NO_ELIGIBLE_CONTRACTOR",
      operationId: "case/attention/no-candidate/1",
      resolvedAt: null,
    });
  });

  it("resolves allocation attention when an allocation succeeds", async () => {
    await raiseNoEligibleContractorAttention("case/attention/no-candidate/1");

    await caseService.markCaseAssignedForOperation({
      caseId: CASE_ID,
      operationId: "case/allocation/assigned/1",
      actorId: ACTOR_ID,
      actorRole: "WORKER",
    });

    const [record] = await findAttention();
    expect(record.resolvedAt).toEqual(expect.any(String));
  });

  it("resolves every operational attention when the Case reaches a terminal status", async () => {
    await raiseNoEligibleContractorAttention("case/attention/no-candidate/1");
    await raiseAllocationFailedAttention("case/attention/allocation-failed/1");
    await raiseMissedAppointmentAttention("case/attention/missed/1");

    await caseService.updateCaseStatus(CASE_ID, "completed");

    const records = await findAttention();
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.resolvedAt)).toBe(true);
  });

  it("refuses to assign a terminal Case", async () => {
    await caseService.updateCaseStatus(CASE_ID, "cancelled");

    const result = await caseService.markCaseAssignedForOperation({
      caseId: CASE_ID,
      operationId: "case/allocation/terminal/1",
      actorId: ACTOR_ID,
      actorRole: "WORKER",
    });

    expect(result.outcome).toBe("CASE_TERMINAL");
    const [caseRecord] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, CASE_ID));
    expect(caseRecord.status).toBe("cancelled");
  });

  describe("Missed Appointment recovery (PRS-149)", () => {
    function replacementInput(operationId: string) {
      return {
        caseId: CASE_ID,
        operationId,
        actorId: ACTOR_ID,
        actorRole: "RESIDENT" as const,
      };
    }

    it("converges repeated missed attentions and resolves the open record on replacement", async () => {
      await raiseMissedAppointmentAttention(
        `${CASE_ID}/missed-appointment/one`
      );
      await raiseMissedAppointmentAttention(
        `${CASE_ID}/missed-appointment/two`
      );
      expect(await findAttention()).toHaveLength(1);

      const operationId = `${CASE_ID}/replace-missed`;
      await caseService.markCaseAppointmentReplacedForOperation(
        replacementInput(operationId)
      );

      const [attention] = await findAttention();
      expect(attention).toMatchObject({
        kind: "MISSED_APPOINTMENT",
        resolvedAt: expect.any(String),
        resolvedByOperationId: operationId,
      });
    });

    it("an idempotent replacement replay resolves attention raised after its first write", async () => {
      const operationId = `${CASE_ID}/replace-missed-replay`;
      await caseService.markCaseAppointmentReplacedForOperation(
        replacementInput(operationId)
      );
      await raiseMissedAppointmentAttention(
        `${CASE_ID}/missed-appointment/one`
      );

      await caseService.markCaseAppointmentReplacedForOperation(
        replacementInput(operationId)
      );

      const [attention] = await findAttention();
      expect(attention.resolvedAt).toEqual(expect.any(String));
      expect(attention.resolvedByOperationId).toBe(operationId);
    });

    it("allows a later missed Appointment to open a new attention after recovery", async () => {
      await raiseMissedAppointmentAttention(
        `${CASE_ID}/missed-appointment/one`
      );
      await caseService.markCaseAppointmentReplacedForOperation(
        replacementInput(`${CASE_ID}/replace-missed`)
      );
      await raiseMissedAppointmentAttention(
        `${CASE_ID}/missed-appointment/two`
      );

      const records = await findAttention();
      expect(records).toHaveLength(2);
      expect(
        records.filter((record) => record.resolvedAt === null)
      ).toHaveLength(1);
    });
  });

  /**
   * PRS-144: `markCaseBreachedForOperation` and the ACCEPTANCE_SLA_BREACH
   * attention it raises. Folded into this file (rather than a separate one)
   * because the case atom's integration suite shares a single `cases` table
   * across test files with no per-file isolation — each file blanket-deletes
   * it in `beforeEach` — and a third file touching it concurrently was
   * observed to race with case.test.ts's own inserts/deletes.
   *
   * The important property under "resolution" below is that the attention
   * survives a replacement Attempt merely being *assigned* — it must
   * resolve only on acceptance or on the Case going terminal (AC8). A test
   * that only checks "the attention exists" does not cover that distinction.
   */
  describe("Acceptance SLA breach (PRS-144)", () => {
    function breachInput(overrides: Record<string, unknown> = {}) {
      const attemptId = crypto.randomUUID();
      return {
        caseId: CASE_ID,
        operationId: `${CASE_ID}/breach/${attemptId}/pending`,
        attemptId,
        actorId: ACTOR_ID,
        actorRole: "SYSTEM",
        detail: "Contractor did not accept before the acceptance SLA deadline.",
        ...overrides,
      };
    }

    it("returns the Case to pending and raises one ACCEPTANCE_SLA_BREACH attention", async () => {
      const result =
        await caseService.markCaseBreachedForOperation(breachInput());
      expect(result).toEqual({ outcome: "PENDING" });

      const [caseRecord] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, CASE_ID));
      expect(caseRecord.status).toBe("pending");

      const attentions = await findAttention();
      expect(attentions).toHaveLength(1);
      expect(attentions[0]).toMatchObject({
        kind: "ACCEPTANCE_SLA_BREACH",
        resolvedAt: null,
      });
    });

    it("is idempotent by operationId — a replay writes nothing new", async () => {
      const input = breachInput();
      const first = await caseService.markCaseBreachedForOperation(input);
      const replay = await caseService.markCaseBreachedForOperation(input);

      expect(first).toEqual({ outcome: "PENDING" });
      expect(replay).toEqual({ outcome: "PENDING" });

      const attentions = await findAttention();
      expect(attentions).toHaveLength(1);
    });

    it("returns CASE_TERMINAL and leaves a completed Case untouched", async () => {
      await caseService.updateCaseStatus(CASE_ID, "completed");

      const result =
        await caseService.markCaseBreachedForOperation(breachInput());
      expect(result).toEqual({ outcome: "CASE_TERMINAL" });

      const [caseRecord] = await db
        .select()
        .from(cases)
        .where(eq(cases.id, CASE_ID));
      expect(caseRecord.status).toBe("completed");
      expect(await findAttention()).toHaveLength(0);
    });

    describe("resolution (AC8): survives assignment, resolves on acceptance or terminal", () => {
      it("stays open when the replacement Attempt is merely assigned", async () => {
        await caseService.markCaseBreachedForOperation(breachInput());

        const assignResult = await caseService.markCaseAssignedForOperation({
          caseId: CASE_ID,
          operationId: `${CASE_ID}/allocate/replacement`,
          actorId: ACTOR_ID,
          actorRole: "SYSTEM",
        });
        expect(assignResult).toEqual({ outcome: "ASSIGNED" });

        const [attention] = await findAttention();
        expect(attention.kind).toBe("ACCEPTANCE_SLA_BREACH");
        expect(attention.resolvedAt).toBeNull();
      });

      it("resolves once the replacement Attempt is accepted", async () => {
        await caseService.markCaseBreachedForOperation(breachInput());
        await caseService.markCaseAssignedForOperation({
          caseId: CASE_ID,
          operationId: `${CASE_ID}/allocate/replacement`,
          actorId: ACTOR_ID,
          actorRole: "SYSTEM",
        });

        const acceptOperationId = `${CASE_ID}/accept/replacement`;
        await caseService.recordAllocationAcceptance({
          caseId: CASE_ID,
          operationId: acceptOperationId,
          actorId: ACTOR_ID,
          actorRole: "CONTRACTOR",
        });

        const [attention] = await findAttention();
        expect(attention.kind).toBe("ACCEPTANCE_SLA_BREACH");
        expect(attention.resolvedAt).toEqual(expect.any(String));
        expect(attention.resolvedByOperationId).toBe(acceptOperationId);
      });

      it("resolves once the Case reaches a terminal status", async () => {
        await caseService.markCaseBreachedForOperation(breachInput());

        await caseService.updateCaseStatus(CASE_ID, "cancelled");

        const [attention] = await findAttention();
        expect(attention.kind).toBe("ACCEPTANCE_SLA_BREACH");
        expect(attention.resolvedAt).toEqual(expect.any(String));
      });
    });

    describe("POST /internal/cases/:id/allocation-breach", () => {
      it("requires the Worker service token", async () => {
        const res = await app.request(
          `/internal/cases/${CASE_ID}/allocation-breach`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(breachInput()),
          }
        );
        expect(res.status).toBe(401);
      });

      it("rejects a body whose caseId does not match the path", async () => {
        const res = await app.request(
          `/internal/cases/${CASE_ID}/allocation-breach`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${"a".repeat(32)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(breachInput({ caseId: crypto.randomUUID() })),
          }
        );
        expect(res.status).toBe(400);
      });

      it("returns 200 with the PENDING outcome on success", async () => {
        const res = await app.request(
          `/internal/cases/${CASE_ID}/allocation-breach`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${"a".repeat(32)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(breachInput()),
          }
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ outcome: "PENDING" });
      });
    });
  });

  describe("GET /api/cases/officer-attention?caseId= (PRS-151)", () => {
    it("narrows to one Case's attention while the unfiltered call still returns both", async () => {
      const otherCaseId = crypto.randomUUID();
      await db.insert(cases).values({
        id: otherCaseId,
        residentId: RESIDENT_ID,
        category: "LE",
        status: "pending",
      });

      await raiseNoEligibleContractorAttention(
        "case/attention/scope/this-case"
      );
      await caseService.raiseOfficerAttention({
        caseId: otherCaseId,
        kind: "NO_ELIGIBLE_CONTRACTOR",
        detail: "No eligible contractor covers this Case.",
        operationId: "case/attention/scope/other-case",
      });

      const scoped = await app.request(
        `/api/cases/officer-attention?caseId=${CASE_ID}`,
        { headers: workerHeaders }
      );
      expect(scoped.status).toBe(200);
      const scopedBody = await scoped.json();
      expect(scopedBody.attentions).toHaveLength(1);
      expect(scopedBody.attentions[0].caseId).toBe(CASE_ID);

      // A generous pageSize (still bounded by the 100 cap) rather than the
      // default 25 — this file's suite shares the Testcontainer DB with
      // case.test.ts (no per-file isolation), so the unfiltered call must
      // not flake just because unrelated open attentions from a concurrent
      // run outrank these two on `desc(createdAt)`.
      const unfiltered = await app.request(
        "/api/cases/officer-attention?pageSize=100",
        { headers: workerHeaders }
      );
      expect(unfiltered.status).toBe(200);
      const unfilteredCaseIds = (await unfiltered.json()).attentions.map(
        (record: { caseId: string }) => record.caseId
      );
      expect(unfilteredCaseIds).toContain(CASE_ID);
      expect(unfilteredCaseIds).toContain(otherCaseId);

      await db.delete(cases).where(eq(cases.id, otherCaseId));
    });

    it("combines caseId with state=resolved, excluding this Case's still-open attention and another Case's resolved one", async () => {
      const otherCaseId = crypto.randomUUID();
      await db.insert(cases).values({
        id: otherCaseId,
        residentId: RESIDENT_ID,
        category: "LE",
        status: "pending",
      });

      await raiseNoEligibleContractorAttention(
        "case/attention/resolved-scope/this-case"
      );
      await caseService.markCaseAssignedForOperation({
        caseId: CASE_ID,
        operationId: "case/attention/resolved-scope/resolve-this-case",
        actorId: ACTOR_ID,
        actorRole: "WORKER",
      });
      // A different kind, not touched by markCaseAssignedForOperation —
      // stays open and must not leak into the state=resolved result.
      await raiseMissedAppointmentAttention(
        "case/attention/resolved-scope/still-open"
      );

      await caseService.raiseOfficerAttention({
        caseId: otherCaseId,
        kind: "NO_ELIGIBLE_CONTRACTOR",
        detail: "No eligible contractor covers this Case.",
        operationId: "case/attention/resolved-scope/other-case",
      });
      await caseService.markCaseAssignedForOperation({
        caseId: otherCaseId,
        operationId: "case/attention/resolved-scope/resolve-other-case",
        actorId: ACTOR_ID,
        actorRole: "WORKER",
      });

      const res = await app.request(
        `/api/cases/officer-attention?caseId=${CASE_ID}&state=resolved`,
        { headers: workerHeaders }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.attentions).toHaveLength(1);
      expect(body.attentions[0]).toMatchObject({
        caseId: CASE_ID,
        kind: "NO_ELIGIBLE_CONTRACTOR",
        resolvedAt: expect.any(String),
      });

      await db.delete(cases).where(eq(cases.id, otherCaseId));
    });
  });
});

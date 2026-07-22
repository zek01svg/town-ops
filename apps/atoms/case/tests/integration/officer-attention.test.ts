import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let db: any;
let cases: any;
let officerAttention: any;
let caseService: any;

const CASE_ID = "123e4567-e89b-12d3-a456-426614174101";
const RESIDENT_ID = "123e4567-e89b-12d3-a456-426614174102";
const ACTOR_ID = "123e4567-e89b-12d3-a456-426614174103";

describe("Officer Attention persistence", () => {
  beforeAll(async () => {
    const dbModule = await import("../../src/database/db");
    const schemaModule = await import("../../src/database/schema");

    db = dbModule.default;
    cases = schemaModule.cases;
    officerAttention = schemaModule.officerAttention;
    caseService = await import("../../src/service");
  });

  beforeEach(async () => {
    await db.delete(cases);
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

  it("resolves every allocation attention when the Case reaches a terminal status", async () => {
    await raiseNoEligibleContractorAttention("case/attention/no-candidate/1");
    await raiseAllocationFailedAttention("case/attention/allocation-failed/1");

    await caseService.updateCaseStatus(CASE_ID, "completed");

    const records = await findAttention();
    expect(records).toHaveLength(2);
    expect(records.every((record: any) => record.resolvedAt)).toBe(true);
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
});

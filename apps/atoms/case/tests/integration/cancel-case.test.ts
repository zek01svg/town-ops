import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

describe("Case cancellation (PRS-148)", () => {
  let db: typeof import("../../src/database/db").default;
  let cases: typeof import("../../src/database/schema").cases;
  let caseHistory: typeof import("../../src/database/schema").caseHistory;
  let service: typeof import("../../src/service");

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    const schema = await import("../../src/database/schema");
    cases = schema.cases;
    caseHistory = schema.caseHistory;
    service = await import("../../src/service");
  });

  async function seedCase(status: "assigned" | "in_progress" = "assigned") {
    const [record] = await db
      .insert(cases)
      .values({ residentId: crypto.randomUUID(), category: "LE", status })
      .returning();
    if (!record) throw new Error("Case seed insert failed");
    return record;
  }

  it("cancels an eligible Case once, preserves its reason, and replays safely", async () => {
    const record = await seedCase();
    const input = {
      caseId: record.id,
      operationId: `${record.id}/cancel/case`,
      actorId: crypto.randomUUID(),
      actorRole: "RESIDENT" as const,
      reason: "No longer needed",
    };

    const first = await service.cancelCaseForOperation(input);
    const replay = await service.cancelCaseForOperation(input);

    expect(first.outcome).toBe("CANCELLED");
    expect(replay.outcome).toBe("ALREADY_CANCELLED");
    const history = await db
      .select()
      .from(caseHistory)
      .where(eq(caseHistory.caseId, record.id));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      eventType: "CASE_CANCELLED",
      reason: input.reason,
      operationId: input.operationId,
    });
  });

  it("rejects an in-progress Case without writing cancellation history", async () => {
    const record = await seedCase("in_progress");
    const result = await service.cancelCaseForOperation({
      caseId: record.id,
      operationId: `${record.id}/cancel/case`,
      actorId: crypto.randomUUID(),
      actorRole: "OFFICER",
      reason: "No longer needed",
    });

    expect(result).toEqual({ outcome: "NOT_CANCELLABLE" });
    expect(
      await db
        .select()
        .from(caseHistory)
        .where(eq(caseHistory.caseId, record.id))
    ).toHaveLength(0);
  });
});

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => (_c: unknown, next: () => unknown) => next(),
}));

type CaseStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "pending_resident_input"
  | "completed"
  | "cancelled";

function noAccessInput(caseId: string) {
  return {
    caseId,
    operationId: `${caseId}/no-access/case`,
    actorId: crypto.randomUUID(),
    actorRole: "CONTRACTOR" as const,
  };
}

function replacedInput(caseId: string) {
  return {
    caseId,
    operationId: `${caseId}/replace-appointment/case`,
    actorId: crypto.randomUUID(),
    actorRole: "RESIDENT" as const,
  };
}

/**
 * PRS-146: `markCaseNoAccessForOperation` (Saga step 2 of No Access) and
 * `markCaseAppointmentReplacedForOperation` (Saga step 2 of a reschedule).
 * Every test seeds its own randomUUID()-keyed Case — the integration files
 * share one Testcontainer DB with no per-file isolation.
 */
describe("No access and reschedule (PRS-146)", () => {
  let db: typeof import("../../src/database/db").default;
  let cases: typeof import("../../src/database/schema").cases;
  let caseHistory: typeof import("../../src/database/schema").caseHistory;
  let caseOperations: typeof import("../../src/database/schema").caseOperations;
  let caseService: typeof import("../../src/service");
  let app: typeof import("../../src/index").app;

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    const schemaModule = await import("../../src/database/schema");
    cases = schemaModule.cases;
    caseHistory = schemaModule.caseHistory;
    caseOperations = schemaModule.caseOperations;
    caseService = await import("../../src/service");
    app = (await import("../../src/index")).app;
  });

  async function seedCase(status: CaseStatus) {
    const [caseRecord] = await db
      .insert(cases)
      .values({ residentId: crypto.randomUUID(), category: "LE", status })
      .returning();
    if (!caseRecord) throw new Error("Case seed insert failed");
    return caseRecord;
  }

  async function historyFor(caseId: string) {
    return db.select().from(caseHistory).where(eq(caseHistory.caseId, caseId));
  }

  async function statusOf(caseId: string) {
    const [row] = await db.select().from(cases).where(eq(cases.id, caseId));
    return row.status;
  }

  describe("markCaseNoAccessForOperation", () => {
    it("parks the Case on the Resident with one CASE_NO_ACCESS history row", async () => {
      const caseRecord = await seedCase("assigned");

      const result = await caseService.markCaseNoAccessForOperation(
        noAccessInput(caseRecord.id)
      );

      expect(result.outcome).toBe("PENDING_RESIDENT_INPUT");
      if (result.outcome !== "PENDING_RESIDENT_INPUT")
        throw new Error("unreachable");
      expect(result.case.status).toBe("pending_resident_input");
      expect(await statusOf(caseRecord.id)).toBe("pending_resident_input");

      const history = await historyFor(caseRecord.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        eventType: "CASE_NO_ACCESS",
        actorRole: "CONTRACTOR",
      });
    });

    it("is idempotent by operationId — a replay writes no new history", async () => {
      const caseRecord = await seedCase("assigned");
      const input = noAccessInput(caseRecord.id);

      expect(
        (await caseService.markCaseNoAccessForOperation(input)).outcome
      ).toBe("PENDING_RESIDENT_INPUT");

      const replay = await caseService.markCaseNoAccessForOperation(input);
      expect(replay.outcome).toBe("PENDING_RESIDENT_INPUT");
      if (replay.outcome !== "PENDING_RESIDENT_INPUT")
        throw new Error("unreachable");
      expect(replay.case.status).toBe("pending_resident_input");

      expect(await historyFor(caseRecord.id)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(caseOperations)
          .where(eq(caseOperations.caseId, caseRecord.id))
      ).toHaveLength(1);
    });

    it("returns CASE_TERMINAL for a completed Case and leaves it untouched", async () => {
      const caseRecord = await seedCase("completed");

      const result = await caseService.markCaseNoAccessForOperation(
        noAccessInput(caseRecord.id)
      );

      expect(result).toEqual({ outcome: "CASE_TERMINAL" });
      expect(await statusOf(caseRecord.id)).toBe("completed");
      expect(await historyFor(caseRecord.id)).toHaveLength(0);
    });

    it("returns CASE_TERMINAL for a cancelled Case and leaves it untouched", async () => {
      const caseRecord = await seedCase("cancelled");

      const result = await caseService.markCaseNoAccessForOperation(
        noAccessInput(caseRecord.id)
      );

      expect(result).toEqual({ outcome: "CASE_TERMINAL" });
      expect(await statusOf(caseRecord.id)).toBe("cancelled");
    });
  });

  describe("markCaseAppointmentReplacedForOperation", () => {
    // AC7: a Case parked after No Access returns to the assigned lane.
    it("pending_resident_input -> assigned", async () => {
      const caseRecord = await seedCase("pending_resident_input");

      const result = await caseService.markCaseAppointmentReplacedForOperation(
        replacedInput(caseRecord.id)
      );

      expect(result.outcome).toBe("REPLACED");
      if (result.outcome !== "REPLACED") throw new Error("unreachable");
      expect(result.case.status).toBe("assigned");
      expect(await statusOf(caseRecord.id)).toBe("assigned");

      const history = await historyFor(caseRecord.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        eventType: "CASE_APPOINTMENT_REPLACED",
      });
    });

    it("leaves an assigned Case assigned but still records the replacement", async () => {
      const caseRecord = await seedCase("assigned");

      const result = await caseService.markCaseAppointmentReplacedForOperation(
        replacedInput(caseRecord.id)
      );

      expect(result.outcome).toBe("REPLACED");
      expect(await statusOf(caseRecord.id)).toBe("assigned");
      expect(await historyFor(caseRecord.id)).toHaveLength(1);
    });

    it("leaves an in_progress Case in_progress but still records the replacement", async () => {
      const caseRecord = await seedCase("in_progress");

      const result = await caseService.markCaseAppointmentReplacedForOperation(
        replacedInput(caseRecord.id)
      );

      expect(result.outcome).toBe("REPLACED");
      expect(await statusOf(caseRecord.id)).toBe("in_progress");
      expect(await historyFor(caseRecord.id)).toHaveLength(1);
    });

    it("is idempotent by operationId — a replay writes no new history", async () => {
      const caseRecord = await seedCase("pending_resident_input");
      const input = replacedInput(caseRecord.id);

      expect(
        (await caseService.markCaseAppointmentReplacedForOperation(input))
          .outcome
      ).toBe("REPLACED");

      const replay =
        await caseService.markCaseAppointmentReplacedForOperation(input);
      expect(replay.outcome).toBe("REPLACED");
      if (replay.outcome !== "REPLACED") throw new Error("unreachable");
      expect(replay.case.status).toBe("assigned");

      expect(await historyFor(caseRecord.id)).toHaveLength(1);
    });

    it("returns CASE_TERMINAL for a terminal Case and leaves it untouched", async () => {
      const completed = await seedCase("completed");
      const cancelled = await seedCase("cancelled");

      expect(
        await caseService.markCaseAppointmentReplacedForOperation(
          replacedInput(completed.id)
        )
      ).toEqual({ outcome: "CASE_TERMINAL" });
      expect(
        await caseService.markCaseAppointmentReplacedForOperation(
          replacedInput(cancelled.id)
        )
      ).toEqual({ outcome: "CASE_TERMINAL" });

      expect(await statusOf(completed.id)).toBe("completed");
      expect(await statusOf(cancelled.id)).toBe("cancelled");
      expect(await historyFor(completed.id)).toHaveLength(0);
    });
  });

  describe("internal routes", () => {
    const headers = {
      Authorization: `Bearer ${"a".repeat(32)}`,
      "Content-Type": "application/json",
    };

    function post(path: string, body: unknown, authorized = true) {
      return app.request(path, {
        method: "POST",
        headers: authorized ? headers : { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("requires the Worker service token on both routes", async () => {
      const caseRecord = await seedCase("assigned");
      expect(
        (
          await post(
            `/internal/cases/${caseRecord.id}/no-access`,
            noAccessInput(caseRecord.id),
            false
          )
        ).status
      ).toBe(401);
      expect(
        (
          await post(
            `/internal/cases/${caseRecord.id}/appointment-replaced`,
            replacedInput(caseRecord.id),
            false
          )
        ).status
      ).toBe(401);
    });

    it("returns 201 for the no-access write and its replay, 400 on a caseId mismatch, 409 when terminal", async () => {
      const caseRecord = await seedCase("assigned");
      const path = `/internal/cases/${caseRecord.id}/no-access`;

      const first = await post(path, noAccessInput(caseRecord.id));
      expect(first.status).toBe(201);
      expect((await first.json()).outcome).toBe("PENDING_RESIDENT_INPUT");

      const replay = await post(path, noAccessInput(caseRecord.id));
      expect(replay.status).toBe(201);

      const mismatch = await post(path, {
        ...noAccessInput(caseRecord.id),
        caseId: crypto.randomUUID(),
      });
      expect(mismatch.status).toBe(400);

      const terminal = await seedCase("completed");
      const conflict = await post(
        `/internal/cases/${terminal.id}/no-access`,
        noAccessInput(terminal.id)
      );
      expect(conflict.status).toBe(409);
    });

    it("returns 201 for the appointment-replaced write, 400 on a caseId mismatch, 409 when terminal", async () => {
      const caseRecord = await seedCase("pending_resident_input");
      const path = `/internal/cases/${caseRecord.id}/appointment-replaced`;

      const first = await post(path, replacedInput(caseRecord.id));
      expect(first.status).toBe(201);
      const body = await first.json();
      expect(body.outcome).toBe("REPLACED");
      expect(body.case.status).toBe("assigned");

      const mismatch = await post(path, {
        ...replacedInput(caseRecord.id),
        caseId: crypto.randomUUID(),
      });
      expect(mismatch.status).toBe(400);

      const terminal = await seedCase("cancelled");
      const conflict = await post(
        `/internal/cases/${terminal.id}/appointment-replaced`,
        replacedInput(terminal.id)
      );
      expect(conflict.status).toBe(409);
    });
  });
});

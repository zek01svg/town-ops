import type { CommitAllocationInput } from "@townops/orchestration-contract";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("hono/jwk", () => ({
  jwk: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

type Schema = typeof import("../../src/database/schema");

/**
 * PRS-151: the Attempt history read (`/by-case/:case_id/attempts`) and the
 * authoritative Contractor Case scope (`/contractor/:contractor_id/cases`).
 * Both are built on real allocation Attempts and their CURRENT/HISTORICAL
 * derivation, so — like allocation.test.ts and breach.test.ts — these are
 * only meaningful against real PostgreSQL.
 */
describe("Attempt history and Contractor Case scope (PRS-151)", () => {
  let db: typeof import("../../src/database/db").default;
  let schema: Schema;
  let service: typeof import("../../src/service");
  let app: typeof import("../../src/index").app;
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    db = (await import("../../src/database/db")).default;
    schema = await import("../../src/database/schema");
    service = await import("../../src/service");
    app = (await import("../../src/index")).app;
    eq = (await import("drizzle-orm")).eq;
  });

  beforeEach(async () => {
    await db.delete(schema.allocationAttempts);
    await db.delete(schema.assignmentStatusHistory);
    await db.delete(schema.assignments);
    await db.delete(schema.allocationEpoch);
  });

  async function commit(overrides: Partial<CommitAllocationInput> = {}) {
    const snapshot = await service.getAllocationSnapshot();
    const input: CommitAllocationInput = {
      operationId: `op/${crypto.randomUUID()}`,
      caseId: crypto.randomUUID(),
      contractorId: crypto.randomUUID(),
      source: "AUTO_ASSIGN",
      expectedEpoch: snapshot.epoch,
      acceptanceSlaMs: 60_000,
      actorId: crypto.randomUUID(),
      actorRole: "SYSTEM",
      ...overrides,
    };
    return service.commitAllocationAttempt(input);
  }

  describe("GET /api/assignments/by-case/:case_id/attempts", () => {
    it("returns [] when the Case has no Assignment yet", async () => {
      const res = await app.request(
        `/api/assignments/by-case/${crypto.randomUUID()}/attempts`
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ attempts: [] });
    });

    it("includes a BREACHED Attempt alongside its replacement, not just the current one", async () => {
      const caseId = crypto.randomUUID();
      const original = await commit({ caseId });
      if (original.outcome !== "COMMITTED") throw new Error("setup failed");
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${original.attempt.id}`,
        attemptId: original.attempt.id,
        assignmentId: original.assignment.id,
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
      });
      const replacement = await commit({ caseId, source: "BREACH_REASSIGN" });
      if (replacement.outcome !== "COMMITTED") throw new Error("setup failed");

      const res = await app.request(
        `/api/assignments/by-case/${caseId}/attempts`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.attempts
          .map((attempt: { status: string }) => attempt.status)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual(["BREACHED", "PENDING_ACCEPTANCE"]);
      expect(
        body.attempts
          .map((attempt: { id: string }) => attempt.id)
          .toSorted((a, b) => a.localeCompare(b))
      ).toEqual(
        [original.attempt.id, replacement.attempt.id].toSorted((a, b) =>
          a.localeCompare(b)
        )
      );
    });

    it("includes a WITHDRAWN Attempt when the pre-work Assignment is cancelled", async () => {
      const caseId = crypto.randomUUID();
      const committed = await commit({ caseId });
      if (committed.outcome !== "COMMITTED") throw new Error("setup failed");

      await service.cancelAssignmentForCase({
        caseId,
        operationId: `cancel/${crypto.randomUUID()}`,
        changedBy: crypto.randomUUID(),
        reason: "Resident cancelled the request",
      });

      const res = await app.request(
        `/api/assignments/by-case/${caseId}/attempts`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.attempts).toHaveLength(1);
      expect(body.attempts[0]).toMatchObject({
        id: committed.attempt.id,
        status: "WITHDRAWN",
      });
    });
  });

  describe("GET /api/assignments/contractor/:contractor_id/cases", () => {
    it("marks a breached Contractor HISTORICAL and the replacement CURRENT, without assignments.contractor_id ever being set", async () => {
      const caseId = crypto.randomUUID();
      const breachedContractor = crypto.randomUUID();
      const replacementContractor = crypto.randomUUID();

      const original = await commit({
        caseId,
        contractorId: breachedContractor,
      });
      if (original.outcome !== "COMMITTED") throw new Error("setup failed");
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${original.attempt.id}`,
        attemptId: original.attempt.id,
        assignmentId: original.assignment.id,
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
      });
      const replacement = await commit({
        caseId,
        contractorId: replacementContractor,
        source: "BREACH_REASSIGN",
      });
      if (replacement.outcome !== "COMMITTED") throw new Error("setup failed");

      // The Temporal writer never sets this — confirms the scope route
      // below cannot be relying on it (blocker 4 in the PRS-151 recon).
      const [assignmentRow] = await db
        .select()
        .from(schema.assignments)
        .where(eq(schema.assignments.id, original.assignment.id));
      expect(assignmentRow.contractorId).toBeNull();

      const breachedRes = await app.request(
        `/api/assignments/contractor/${breachedContractor}/cases`
      );
      expect(breachedRes.status).toBe(200);
      expect(await breachedRes.json()).toEqual({
        items: [
          {
            caseId,
            assignmentId: original.assignment.id,
            participation: "HISTORICAL",
          },
        ],
        page: 1,
        pageSize: 25,
      });

      const currentRes = await app.request(
        `/api/assignments/contractor/${replacementContractor}/cases`
      );
      expect(currentRes.status).toBe(200);
      expect(await currentRes.json()).toEqual({
        items: [
          {
            caseId,
            assignmentId: original.assignment.id,
            participation: "CURRENT",
          },
        ],
        page: 1,
        pageSize: 25,
      });
    });

    it("returns an empty page for a Contractor with no Attempts", async () => {
      const res = await app.request(
        `/api/assignments/contractor/${crypto.randomUUID()}/cases`
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [], page: 1, pageSize: 25 });
    });

    it("rejects a pageSize over 100", async () => {
      const res = await app.request(
        `/api/assignments/contractor/${crypto.randomUUID()}/cases?pageSize=101`
      );
      expect(res.status).toBe(400);
    });

    it("marks a truly ACCEPTED replacement Attempt CURRENT, not just a PENDING_ACCEPTANCE one", async () => {
      const caseId = crypto.randomUUID();
      const breachedContractor = crypto.randomUUID();
      const replacementContractor = crypto.randomUUID();

      const original = await commit({
        caseId,
        contractorId: breachedContractor,
      });
      if (original.outcome !== "COMMITTED") throw new Error("setup failed");
      await service.breachAllocationAttempt({
        operationId: `${crypto.randomUUID()}/breach/${original.attempt.id}`,
        attemptId: original.attempt.id,
        assignmentId: original.assignment.id,
        actorId: crypto.randomUUID(),
        actorRole: "SYSTEM",
      });
      const replacement = await commit({
        caseId,
        contractorId: replacementContractor,
        source: "BREACH_REASSIGN",
      });
      if (replacement.outcome !== "COMMITTED") throw new Error("setup failed");

      const acceptRes = await app.request(
        "/internal/assignments/allocation-attempts/acceptance",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"a".repeat(32)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            operationId: `accept/${crypto.randomUUID()}`,
            caseId,
            assignmentId: replacement.assignment.id,
            attemptId: replacement.attempt.id,
            contractorId: replacementContractor,
          }),
        }
      );
      expect(acceptRes.status).toBe(201);

      const currentRes = await app.request(
        `/api/assignments/contractor/${replacementContractor}/cases`
      );
      expect(await currentRes.json()).toEqual({
        items: [
          {
            caseId,
            assignmentId: original.assignment.id,
            participation: "CURRENT",
          },
        ],
        page: 1,
        pageSize: 25,
      });

      const historicalRes = await app.request(
        `/api/assignments/contractor/${breachedContractor}/cases`
      );
      expect(await historicalRes.json()).toEqual({
        items: [
          {
            caseId,
            assignmentId: original.assignment.id,
            participation: "HISTORICAL",
          },
        ],
        page: 1,
        pageSize: 25,
      });
    });

    // `commitAllocationAttempt` serializes every insert through the epoch
    // row lock in its own transaction, so it cannot produce two Attempts
    // sharing one `createdAt` — this seeds `assignments`/`allocationAttempts`
    // directly instead, the same workaround the other tests in this
    // describe block already use for state setup. One multi-row INSERT per
    // table: `defaultNow()` is transaction-scoped, so every row in the
    // batch shares an identical `createdAt`, which is exactly the tie that
    // makes `listCasesForContractor`'s pagination non-deterministic without
    // `assignments.id` as a secondary sort key on the page query.
    it("keeps page 1 / page 2 disjoint with a stable full-set union across 26 Cases sharing one createdAt tie", async () => {
      const contractorId = crypto.randomUUID();
      const caseIds = Array.from({ length: 26 }, () => crypto.randomUUID());

      const insertedAssignments = await db
        .insert(schema.assignments)
        .values(caseIds.map((caseId) => ({ caseId })))
        .returning();

      const insertedAttempts = await db
        .insert(schema.allocationAttempts)
        .values(
          insertedAssignments.map((assignment) => ({
            assignmentId: assignment.id,
            contractorId,
            source: "AUTO_ASSIGN" as const,
            acceptanceSlaMs: 60_000,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            actorId: crypto.randomUUID(),
            actorRole: "SYSTEM",
            operationId: `op/${crypto.randomUUID()}`,
          }))
        )
        .returning();

      // Measure the tie rather than assume it — if drizzle ever splits this
      // into per-row statements, or defaultNow() semantics change, this
      // fails loudly instead of silently testing nothing.
      expect(new Set(insertedAttempts.map((a) => a.createdAt)).size).toBe(1);

      const firstPage = await app.request(
        `/api/assignments/contractor/${contractorId}/cases`
      );
      expect(firstPage.status).toBe(200);
      const firstBody = await firstPage.json();
      expect(firstBody.page).toBe(1);
      expect(firstBody.pageSize).toBe(25);
      expect(firstBody.items).toHaveLength(25);

      const secondPage = await app.request(
        `/api/assignments/contractor/${contractorId}/cases?page=2`
      );
      expect(secondPage.status).toBe(200);
      const secondBody = await secondPage.json();
      expect(secondBody.items).toHaveLength(1);

      const firstCaseIds = firstBody.items.map(
        (item: { caseId: string }) => item.caseId
      );
      const secondCaseIds = secondBody.items.map(
        (item: { caseId: string }) => item.caseId
      );

      // The real assertion: no Case appears on both pages, and the two
      // pages together cover every seeded Case exactly once — not just
      // correctly sized. This is what a missing `assignments.id` tiebreak
      // would break with 26 rows sharing one createdAt.
      expect(new Set([...firstCaseIds, ...secondCaseIds]).size).toBe(26);
      expect(
        [...firstCaseIds, ...secondCaseIds].toSorted((a, b) =>
          a.localeCompare(b)
        )
      ).toEqual(caseIds.toSorted((a, b) => a.localeCompare(b)));
      expect(
        [...firstBody.items, ...secondBody.items].every(
          (item: { participation: string }) => item.participation === "CURRENT"
        )
      ).toBe(true);
    });

    // Stresses the tiebreak the builder just added to `attemptsByRecency`
    // (`allocationAttempts.id` as a secondary sort key) rather than the
    // pagination tiebreak above. Same direct-seed workaround for the same
    // reason: the public path cannot produce a genuine createdAt tie
    // between two Attempts on the same Assignment. Six contenders rather
    // than two: with a missing tiebreak, Postgres's tie order is not
    // random but it is also not `id`-derived, so a 2-way guess would still
    // pass by accident close to half the time — six cuts that to 1-in-6
    // per run, and every test run re-rolls fresh UUIDs so it is not the
    // same coin flip twice.
    it("resolves CURRENT/HISTORICAL deterministically when six Attempts on the same Assignment share an identical createdAt", async () => {
      const caseId = crypto.randomUUID();
      const contractorIds = Array.from({ length: 6 }, () =>
        crypto.randomUUID()
      );

      const [assignment] = await db
        .insert(schema.assignments)
        .values({ caseId })
        .returning();

      const insertedAttempts = await db
        .insert(schema.allocationAttempts)
        .values(
          contractorIds.map((contractorId) => ({
            assignmentId: assignment.id,
            contractorId,
            source: "AUTO_ASSIGN" as const,
            acceptanceSlaMs: 60_000,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            actorId: crypto.randomUUID(),
            actorRole: "SYSTEM",
            operationId: `op/${crypto.randomUUID()}`,
          }))
        )
        .returning();

      // Measure the tie rather than assume it (see the pagination test
      // above for why).
      expect(new Set(insertedAttempts.map((a) => a.createdAt)).size).toBe(1);

      // The service's documented rule: a createdAt tie breaks on
      // `allocationAttempts.id` ascending. Predict the winner the same way
      // so this test fails loudly if that tiebreak is missing or wrong,
      // rather than passing by coincidence.
      const [winner, ...losers] = insertedAttempts.toSorted((a, b) =>
        a.id < b.id ? -1 : 1
      );

      const winnerRes = await app.request(
        `/api/assignments/contractor/${winner.contractorId}/cases`
      );
      expect(await winnerRes.json()).toEqual({
        items: [
          { caseId, assignmentId: assignment.id, participation: "CURRENT" },
        ],
        page: 1,
        pageSize: 25,
      });

      for (const loser of losers) {
        const loserRes = await app.request(
          `/api/assignments/contractor/${loser.contractorId}/cases`
        );
        expect(await loserRes.json()).toEqual({
          items: [
            {
              caseId,
              assignmentId: assignment.id,
              participation: "HISTORICAL",
            },
          ],
          page: 1,
          pageSize: 25,
        });
      }
    });
  });

  describe("Route collisions (PRS-151)", () => {
    it("still reaches the legacy /contractor/:contractor_id (no /cases suffix), unshadowed by its new sibling", async () => {
      const contractorId = crypto.randomUUID();
      const res = await app.request(
        `/api/assignments/contractor/${contractorId}`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // The legacy route's shape (`{ assignments: [...] }`) is distinct
      // from the new scope route's (`{ items, page, pageSize }`) — proves
      // which handler actually ran.
      expect(body).toHaveProperty("assignments");
      expect(body).not.toHaveProperty("items");
    });

    it("still reaches /api/assignments/:case_id and /:case_id/history, unshadowed by the new /by-case/* siblings", async () => {
      const caseId = crypto.randomUUID();
      const committed = await commit({ caseId });
      if (committed.outcome !== "COMMITTED") throw new Error("setup failed");

      const byCaseId = await app.request(`/api/assignments/${caseId}`);
      expect(byCaseId.status).toBe(200);
      const byCaseIdBody = await byCaseId.json();
      expect(byCaseIdBody.assignments.id).toBe(committed.assignment.id);

      const history = await app.request(`/api/assignments/${caseId}/history`);
      expect(history.status).toBe(200);
      const historyBody = await history.json();
      expect(historyBody).toHaveProperty("history");
      expect(Array.isArray(historyBody.history)).toBe(true);
    });
  });
});

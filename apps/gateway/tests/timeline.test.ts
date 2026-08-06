import { randomUUID } from "node:crypto";

import { TimelineEventDtoSchema } from "@townops/orchestration-contract";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  createApp,
  officerAuth,
  otherResidentId,
  residentAuth,
  residentId,
  successResult,
} from "./helpers";

const caseId = successResult.data.id;
const assignmentId = "a1a1a1a1-1111-4111-8111-111111111111";
const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
const replacementContractorId = "e2e2e2e2-2222-4222-8222-222222222222";
const systemActorId = "00000000-0000-0000-0000-000000000000";

const contractorAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "d5d5d5d5-5555-4555-8555-555555555555",
    role: "contractor",
    contractorId,
  });
  await next();
};
const replacementContractorAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "f6f6f6f6-6666-4666-8666-666666666666",
    role: "contractor",
    contractorId: replacementContractorId,
  });
  await next();
};

function requestHref(url: RequestInfo | URL) {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

const caseRecord = {
  ...successResult.data,
  residentId,
  priority: "high",
  status: "assigned",
};

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    assignmentId,
    contractorId,
    source: "AUTO_ASSIGN",
    status: "PENDING_ACCEPTANCE",
    acceptanceSlaMs: 60_000,
    deadlineAt: "2030-01-01T00:01:00.000Z",
    actorId: systemActorId,
    actorRole: "SYSTEM",
    reason: null,
    operationId: "allocate/1",
    createdAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function caseHistoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    caseId,
    eventType: "CASE_OPENED",
    actorId: residentId,
    actorRole: "RESIDENT",
    reason: null,
    operationId: "open/1",
    createdAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignmentStatusRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    assignmentId,
    fromStatus: "PENDING_ACCEPTANCE",
    toStatus: "ACCEPTED",
    changedAt: "2030-01-02T00:00:00.000Z",
    changedBy: contractorId,
    reason: null,
    ...overrides,
  };
}

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    caseId,
    assignmentId,
    attemptId: randomUUID(),
    contractorId,
    startTime: "2030-01-03T09:00:00.000Z",
    endTime: "2030-01-03T10:00:00.000Z",
    status: "SCHEDULED",
    reason: null,
    operationId: "accept/1",
    createdAt: "2030-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function proofItem(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    caseId,
    contractorId,
    mediaUrl: "https://proof.example/1",
    type: "BEFORE",
    remarks: null,
    checksum: "a".repeat(64),
    ready: true,
    createdAt: "2030-01-04T00:00:00.000Z",
    ...overrides,
  };
}

function effect(overrides: Record<string, unknown> = {}) {
  return {
    id: "effect-1",
    caseId,
    type: "EMAIL",
    purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
    status: "SENT",
    providerId: "provider-1",
    providerIdempotencyKey: "effect-1",
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    contractorId: null,
    scoreDelta: null,
    createdAt: "2030-01-05T00:00:00.000Z",
    updatedAt: "2030-01-05T00:00:00.000Z",
    ...overrides,
  };
}

function attention(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    caseId,
    kind: "MISSED_APPOINTMENT",
    detail: "No contact at the door",
    operationId: "attn/1",
    effectId: null,
    createdAt: "2030-01-06T00:00:00.000Z",
    resolvedAt: null,
    resolvedByOperationId: null,
    ...overrides,
  };
}

/**
 * Dispatches by exact, caseId-scoped path so the multiple `/history`-suffixed
 * and `/api/cases`-prefixed routes never collide — the bare Case lookup is a
 * literal prefix of its own `/history` route, so it is checked last.
 */
function timelineFetch(options: {
  caseRecord?: unknown;
  attempts?: unknown[];
  attemptsThrow?: boolean;
  attemptsNotOk?: boolean;
  caseHistory?: unknown[];
  assignmentHistory?: unknown[];
  appointments?: unknown[];
  appointmentsThrow?: boolean;
  proofItems?: unknown[];
  proofItemsNotOk?: boolean;
  effects?: unknown[];
  openAttentions?: unknown[];
  resolvedAttentions?: unknown[];
}): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = requestHref(url);
    if (href.includes(`/api/assignments/by-case/${caseId}/attempts`)) {
      if (options.attemptsThrow) throw new Error("ECONNREFUSED");
      if (options.attemptsNotOk) return new Response("boom", { status: 500 });
      return Response.json({ attempts: options.attempts ?? [] });
    }
    if (href.includes(`/api/assignments/${caseId}/history`)) {
      return Response.json({ history: options.assignmentHistory ?? [] });
    }
    if (href.includes(`/api/cases/${caseId}/history`)) {
      return Response.json({ history: options.caseHistory ?? [] });
    }
    if (href.includes("/api/cases/officer-attention")) {
      const isResolved = href.includes("state=resolved");
      return Response.json({
        attentions: isResolved
          ? (options.resolvedAttentions ?? [])
          : (options.openAttentions ?? []),
      });
    }
    if (href.includes(`/internal/proof-items/${caseId}`)) {
      if (options.proofItemsNotOk) return new Response("boom", { status: 500 });
      return Response.json({ proof: options.proofItems ?? [] });
    }
    if (href.includes(`/internal/effects/case/${caseId}`)) {
      return Response.json({ effects: options.effects ?? [] });
    }
    if (href.includes(`/api/appointments/${caseId}`)) {
      if (options.appointmentsThrow) throw new Error("ECONNREFUSED");
      return Response.json({ appointments: options.appointments ?? [] });
    }
    return Response.json({
      cases: options.caseRecord ? [options.caseRecord] : [],
    });
  });
}

describe("GET /api/cases/:caseId/timeline (PRS-151)", () => {
  it("merges all seven sources into one ascending, deterministically tie-broken list", async () => {
    // ALLOCATION_ATTEMPT and CASE_HISTORY share an `at` on purpose, and
    // CASE_HISTORY is pushed first by the route's own source order — a sort
    // with no explicit tiebreak would leave it first. The expected order
    // below only holds if the `(at, source, id)` tiebreak actually runs.
    const sharedAt = "2030-01-01T00:00:00.000Z";
    const theAttempt = attempt({ createdAt: sharedAt });
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [theAttempt],
      caseHistory: [caseHistoryRow({ createdAt: sharedAt })],
      assignmentHistory: [assignmentStatusRow()],
      appointments: [appointmentRow()],
      proofItems: [proofItem()],
      effects: [effect()],
      openAttentions: [attention({ createdAt: "2030-01-06T00:00:00.000Z" })],
      resolvedAttentions: [
        attention({
          id: randomUUID(),
          createdAt: "2030-01-07T00:00:00.000Z",
          resolvedAt: "2030-01-08T00:00:00.000Z",
          resolvedByOperationId: "resolve/1",
        }),
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.missingSources).toEqual([]);
    expect(
      body.data.items.map((item: { source: string }) => item.source)
    ).toEqual([
      "ALLOCATION_ATTEMPT",
      "CASE_HISTORY",
      "ASSIGNMENT_STATUS",
      "APPOINTMENT",
      "PROOF_ITEM",
      "DERIVED_EFFECT",
      "OFFICER_ATTENTION",
      "OFFICER_ATTENTION",
    ]);
    expect(body.data.items[0]).toMatchObject({
      source: "ALLOCATION_ATTEMPT",
      type: theAttempt.status,
      actorId: theAttempt.actorId,
      actorRole: theAttempt.actorRole,
      operationId: theAttempt.operationId,
    });
  });

  it("degrades to a sorted partial with the failing source named, when an atom rejects the fetch", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [attempt()],
      caseHistory: [caseHistoryRow()],
      assignmentHistory: [assignmentStatusRow()],
      appointmentsThrow: true,
      proofItems: [proofItem()],
      effects: [effect()],
      openAttentions: [],
      resolvedAttentions: [],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.missingSources).toEqual(["APPOINTMENT"]);
    // The remaining six sources, still ascending by `at` with the
    // ALLOCATION_ATTEMPT/CASE_HISTORY tie broken by source name.
    expect(
      body.data.items.map((item: { source: string }) => item.source)
    ).toEqual([
      "ALLOCATION_ATTEMPT",
      "CASE_HISTORY",
      "ASSIGNMENT_STATUS",
      "PROOF_ITEM",
      "DERIVED_EFFECT",
    ]);
  });

  it("degrades to a sorted partial with the failing source named, when an atom answers non-ok (distinct from a rejected fetch)", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [attempt()],
      caseHistory: [caseHistoryRow()],
      assignmentHistory: [assignmentStatusRow()],
      appointments: [appointmentRow()],
      proofItemsNotOk: true,
      effects: [effect()],
      openAttentions: [],
      resolvedAttentions: [],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.missingSources).toEqual(["PROOF_ITEM"]);
    // The remaining six sources, still ascending by `at` with the
    // ALLOCATION_ATTEMPT/CASE_HISTORY tie broken by source name.
    expect(
      body.data.items.map((item: { source: string }) => item.source)
    ).toEqual([
      "ALLOCATION_ATTEMPT",
      "CASE_HISTORY",
      "ASSIGNMENT_STATUS",
      "APPOINTMENT",
      "DERIVED_EFFECT",
    ]);
  });

  it("404s an unauthorized Resident without ever touching a secondary atom (AC7 before AC8)", async () => {
    // Owned by someone else — `residentAuth`'s subject is `residentId`, not this.
    const foreignCaseRecord = { ...caseRecord, residentId: otherResidentId };
    const fetchImpl = timelineFetch({ caseRecord: foreignCaseRecord });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });
    // Only the Case atom's primary lookup — the fan-out never ran.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("404s a Contractor who never held the Case, after checking exactly the Case atom and the Attempt history (AC7 before AC8)", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [attempt({ contractorId: replacementContractorId })],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });
    // Case atom primary lookup + the Attempt history authorization check —
    // the rest of the fan-out never ran.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns 503, not 404, when a Contractor's Attempt history is unavailable — authorization defers, never grants", async () => {
    const fetchImpl = timelineFetch({ caseRecord, attemptsThrow: true });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("hides a replacement Contractor's rows entirely from the historical Contractor who was replaced — including the two channels that leaked before the fix", async () => {
    const replacedAttempt = attempt({
      id: randomUUID(),
      contractorId,
      status: "BREACHED",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    const currentAttempt = attempt({
      id: randomUUID(),
      contractorId: replacementContractorId,
      status: "PENDING_ACCEPTANCE",
      source: "BREACH_REASSIGN",
      reason: "SLA breach",
      createdAt: "2030-01-02T00:00:00.000Z",
    });
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [replacedAttempt, currentAttempt],
      appointments: [
        appointmentRow({ id: randomUUID(), contractorId }),
        appointmentRow({
          id: randomUUID(),
          contractorId: replacementContractorId,
        }),
      ],
      proofItems: [
        proofItem({ id: randomUUID(), contractorId }),
        proofItem({ id: randomUUID(), contractorId: replacementContractorId }),
      ],
      effects: [
        effect({
          id: "effect-own",
          type: "PERFORMANCE_ENTRY",
          purpose: "ATTEMPT_BREACH_PERFORMANCE",
          contractorId,
          scoreDelta: -5,
        }),
        effect({
          id: "effect-replacement",
          type: "PERFORMANCE_ENTRY",
          purpose: "ATTEMPT_BREACH_PERFORMANCE",
          contractorId: replacementContractorId,
          scoreDelta: -5,
        }),
      ],
      // The two channels the fix closes: `changed_by` on a status-history row
      // and an auto-allocation `operationId` both carry the winning
      // Contractor's id as plain text, with no per-row `contractorId` field
      // for the shared filter to key off. Before the fix these two sources
      // were not in `scopedToOwnContractor` at all, so they fell through to
      // `return true` unfiltered for every Contractor, current or
      // historical — planting the replacement's id here and asserting the
      // whole-body leak check below is what would have caught it.
      assignmentHistory: [
        assignmentStatusRow({
          id: randomUUID(),
          changedBy: replacementContractorId,
        }),
      ],
      caseHistory: [
        caseHistoryRow({
          id: randomUUID(),
          eventType: "CASE_ASSIGNED",
          actorId: null,
          actorRole: "SYSTEM",
          operationId: `${caseId}/allocate/${replacementContractorId}/3`,
        }),
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(replacementContractorId);

    // Not over-redacted: the historical Contractor's own rows on all four
    // sources AC5 actually names still come through.
    const sources = body.data.items.map(
      (item: { source: string }) => item.source
    );
    expect(sources).toContain("ALLOCATION_ATTEMPT");
    expect(sources).toContain("APPOINTMENT");
    expect(sources).toContain("PROOF_ITEM");
    expect(sources).toContain("DERIVED_EFFECT");
    expect(JSON.stringify(body)).toContain(contractorId);

    // CASE_HISTORY and ASSIGNMENT_STATUS are dropped wholesale for a
    // HISTORICAL Contractor — even a row naming only itself, since neither
    // source carries reliable per-row contractor attribution to scope by.
    expect(sources).not.toContain("CASE_HISTORY");
    expect(sources).not.toContain("ASSIGNMENT_STATUS");
  });

  it("gives the CURRENT Contractor a replaced predecessor's rows too, and keeps CASE_HISTORY/ASSIGNMENT_STATUS — the row filter and the two-source drop only apply once historical", async () => {
    const replacedAttempt = attempt({
      id: randomUUID(),
      contractorId,
      status: "BREACHED",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    const currentAttempt = attempt({
      id: randomUUID(),
      contractorId: replacementContractorId,
      status: "PENDING_ACCEPTANCE",
      source: "BREACH_REASSIGN",
      createdAt: "2030-01-02T00:00:00.000Z",
    });
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [replacedAttempt, currentAttempt],
      appointments: [appointmentRow({ id: randomUUID(), contractorId })],
      // Referencing the CURRENT Contractor itself (`replacementContractorId`)
      // — these must still come through, proving the two-source drop is
      // HISTORICAL-only, not a blanket rule.
      assignmentHistory: [
        assignmentStatusRow({
          id: randomUUID(),
          changedBy: replacementContractorId,
        }),
      ],
      caseHistory: [
        caseHistoryRow({
          id: randomUUID(),
          eventType: "CASE_ASSIGNED",
          operationId: `${caseId}/allocate/${replacementContractorId}/3`,
        }),
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: replacementContractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    // The CURRENT Contractor still sees the replaced predecessor's Attempt
    // and Appointment — only a HISTORICAL Contractor's view is narrowed.
    expect(JSON.stringify(body)).toContain(contractorId);
    const sources = body.data.items.map(
      (item: { source: string }) => item.source
    );
    expect(sources).toContain("CASE_HISTORY");
    expect(sources).toContain("ASSIGNMENT_STATUS");
  });

  it("drops Performance Entries and Officer Attention from a Resident's timeline", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      effects: [
        effect({ id: "email-1", type: "EMAIL" }),
        effect({
          id: "perf-1",
          type: "PERFORMANCE_ENTRY",
          purpose: "ATTEMPT_BREACH_PERFORMANCE",
          contractorId,
          scoreDelta: -5,
        }),
      ],
      openAttentions: [attention()],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.data.items.some(
        (item: { source: string }) => item.source === "OFFICER_ATTENTION"
      )
    ).toBe(false);
    expect(
      body.data.items.some(
        (item: { source: string; type: string }) =>
          item.source === "DERIVED_EFFECT" && item.type === "PERFORMANCE_ENTRY"
      )
    ).toBe(false);
    // The EMAIL effect proves the whole DERIVED_EFFECT source was not dropped.
    expect(
      body.data.items.some(
        (item: { source: string; type: string }) =>
          item.source === "DERIVED_EFFECT" && item.type === "EMAIL"
      )
    ).toBe(true);
  });

  it("hides Contractor churn from a Resident across every channel that could carry it", async () => {
    const replacedAttempt = attempt({
      id: randomUUID(),
      contractorId,
      status: "BREACHED",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    const currentAttempt = attempt({
      id: randomUUID(),
      contractorId: replacementContractorId,
      status: "PENDING_ACCEPTANCE",
      source: "BREACH_REASSIGN",
      createdAt: "2030-01-02T00:00:00.000Z",
    });
    const fetchImpl = timelineFetch({
      caseRecord,
      // ALLOCATION_ATTEMPT and ASSIGNMENT_STATUS are fully denied to a
      // Resident, but planted here anyway rather than trusted from reading
      // the switch — the whole-body check below is a black-box proof, not a
      // restatement of the source.
      attempts: [replacedAttempt, currentAttempt],
      assignmentHistory: [
        assignmentStatusRow({
          id: randomUUID(),
          changedBy: replacementContractorId,
        }),
      ],
      // CASE_HISTORY is reachable but redacted — plant the id in both
      // fields `redactForResident` must null.
      caseHistory: [
        caseHistoryRow({
          id: randomUUID(),
          eventType: "CASE_ASSIGNED",
          actorId: replacementContractorId,
          operationId: `${caseId}/allocate/${replacementContractorId}/3`,
        }),
      ],
      // APPOINTMENT and PROOF_ITEM are reachable but redacted too.
      appointments: [
        appointmentRow({
          id: randomUUID(),
          contractorId: replacementContractorId,
        }),
      ],
      proofItems: [
        proofItem({ id: randomUUID(), contractorId: replacementContractorId }),
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(replacementContractorId);
  });

  it("still gives a Resident CASE_HISTORY (actorRole intact), a narrowed APPOINTMENT, PROOF_ITEM, and email DERIVED_EFFECT rows — not over-redacted", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      caseHistory: [
        caseHistoryRow({ id: randomUUID(), actorRole: "CONTRACTOR" }),
      ],
      appointments: [appointmentRow({ id: randomUUID() })],
      proofItems: [proofItem({ id: randomUUID() })],
      effects: [effect({ id: "email-1", type: "EMAIL" })],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    const sources = body.data.items.map(
      (item: { source: string }) => item.source
    );
    expect(sources).toContain("CASE_HISTORY");
    expect(sources).toContain("APPOINTMENT");
    expect(sources).toContain("PROOF_ITEM");
    expect(sources).toContain("DERIVED_EFFECT");
    expect(sources).not.toContain("ALLOCATION_ATTEMPT");
    expect(sources).not.toContain("ASSIGNMENT_STATUS");
    expect(sources).not.toContain("OFFICER_ATTENTION");

    // `actorRole` is the deliberate carve-out on CASE_HISTORY — "a
    // Contractor did this" is useful and non-identifying.
    const caseHistoryItem = body.data.items.find(
      (item: { source: string }) => item.source === "CASE_HISTORY"
    );
    expect(caseHistoryItem.actorRole).toBe("CONTRACTOR");

    // APPOINTMENT's `detail` is narrowed to exactly the field set Case
    // detail already gives a Resident — nothing more, nothing less.
    const appointmentItem = body.data.items.find(
      (item: { source: string }) => item.source === "APPOINTMENT"
    );
    expect(Object.keys(appointmentItem.detail).toSorted()).toEqual(
      ["id", "startTime", "endTime", "status", "reason"].toSorted()
    );
    // The flattened top-level `operationId` is nulled too, matching the DTO.
    expect(appointmentItem.operationId).toBeNull();
  });

  it("redacts inside `detail`, not just the flattened top-level fields", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      caseHistory: [
        caseHistoryRow({
          id: randomUUID(),
          actorId: contractorId,
          operationId: `${caseId}/allocate/${contractorId}/1`,
        }),
      ],
      proofItems: [proofItem({ id: randomUUID(), contractorId })],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    const caseHistoryItem = body.data.items.find(
      (item: { source: string }) => item.source === "CASE_HISTORY"
    );
    expect(caseHistoryItem.actorId).toBeNull();
    expect(caseHistoryItem.operationId).toBeNull();
    // A check that stopped at the flattened fields above would miss a
    // regression that only re-added the raw row (with its own actorId and
    // operationId) as `detail`.
    expect(caseHistoryItem.detail.actorId).toBeNull();
    expect(caseHistoryItem.detail.operationId).toBeNull();

    const proofItemEntry = body.data.items.find(
      (item: { source: string }) => item.source === "PROOF_ITEM"
    );
    expect(proofItemEntry.detail.contractorId).toBeNull();

    expect(JSON.stringify(body)).not.toContain(contractorId);
  });

  it("leaves the Officer's timeline unredacted on every source, detail included", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [attempt({ contractorId })],
      caseHistory: [
        caseHistoryRow({
          id: randomUUID(),
          actorId: contractorId,
          operationId: `${caseId}/allocate/${contractorId}/1`,
        }),
      ],
      assignmentHistory: [assignmentStatusRow({ changedBy: contractorId })],
      appointments: [appointmentRow({ id: randomUUID(), contractorId })],
      proofItems: [proofItem({ id: randomUUID(), contractorId })],
      effects: [effect()],
      openAttentions: [attention()],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    const sources = body.data.items.map(
      (item: { source: string }) => item.source
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        "CASE_HISTORY",
        "ALLOCATION_ATTEMPT",
        "ASSIGNMENT_STATUS",
        "APPOINTMENT",
        "PROOF_ITEM",
        "DERIVED_EFFECT",
        "OFFICER_ATTENTION",
      ])
    );
    expect(JSON.stringify(body)).toContain(contractorId);
    const caseHistoryItem = body.data.items.find(
      (item: { source: string }) => item.source === "CASE_HISTORY"
    );
    expect(caseHistoryItem.actorId).toBe(contractorId);
    expect(caseHistoryItem.operationId).toBe(
      `${caseId}/allocate/${contractorId}/1`
    );
    expect(caseHistoryItem.detail.operationId).toBe(
      `${caseId}/allocate/${contractorId}/1`
    );
    const appointmentItem = body.data.items.find(
      (item: { source: string }) => item.source === "APPOINTMENT"
    );
    expect(appointmentItem.detail.contractorId).toBe(contractorId);
  });

  it("breaks a tie on identical (at, source) by id — the sort's third level", async () => {
    const sharedAt = "2030-01-01T00:00:00.000Z";
    const rowA = caseHistoryRow({
      id: "aaaaaaaa-0000-4000-8000-000000000000",
      createdAt: sharedAt,
      eventType: "FIRST",
    });
    const rowB = caseHistoryRow({
      id: "bbbbbbbb-0000-4000-8000-000000000000",
      createdAt: sharedAt,
      eventType: "SECOND",
    });
    // Handed to the route in reverse id order — a sort that stopped at
    // `(at, source)` (or relied on input order) would leave SECOND first.
    const fetchImpl = timelineFetch({
      caseRecord,
      caseHistory: [rowB, rowA],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    const caseHistoryItems = body.data.items.filter(
      (item: { source: string }) => item.source === "CASE_HISTORY"
    );
    expect(caseHistoryItems.map((item: { type: string }) => item.type)).toEqual(
      ["FIRST", "SECOND"]
    );
  });

  it("keeps well-formed rows in correct relative order around a row with an unparseable `at`", async () => {
    // `caseHistoryEvent` only type-guards `createdAt` is a string, not that
    // it parses — `compareTimelineEvents` falls back to a string compare
    // rather than let `Date.parse`'s `NaN` fail every comparison. The risk
    // is that one malformed row corrupts the order of its well-formed
    // neighbours, not just its own placement.
    const earlier = caseHistoryRow({
      id: randomUUID(),
      createdAt: "2030-01-01T00:00:00.000Z",
      eventType: "EARLIER",
    });
    const later = caseHistoryRow({
      id: randomUUID(),
      createdAt: "2030-01-02T00:00:00.000Z",
      eventType: "LATER",
    });
    const malformed = caseHistoryRow({
      id: randomUUID(),
      createdAt: "not-a-date",
      eventType: "MALFORMED",
    });
    const fetchImpl = timelineFetch({
      caseRecord,
      caseHistory: [later, malformed, earlier],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    const types = body.data.items
      .filter((item: { source: string }) => item.source === "CASE_HISTORY")
      .map((item: { type: string }) => item.type);
    expect(types).toContain("EARLIER");
    expect(types).toContain("LATER");
    expect(types).toContain("MALFORMED");
    // Wherever the malformed row lands, EARLIER must still precede LATER.
    expect(types.indexOf("EARLIER")).toBeLessThan(types.indexOf("LATER"));
  });

  it("still 404s an unauthorized Resident even when every atom the timeline could reach is down — never a 503 that reveals the Case exists, never a partial (AC7 before AC8)", async () => {
    const foreignCaseRecord = { ...caseRecord, residentId: otherResidentId };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      // The Case atom's primary lookup is the only call that may succeed —
      // every other atom this route could reach is deliberately hostile. If
      // the fan-out ran before authorization, this would surface as a 500
      // (an uncaught throw) or a 503, not the 404 asserted below.
      if (href.endsWith(`/api/cases/${caseId}`)) {
        return Response.json({ cases: [foreignCaseRecord] });
      }
      throw new Error("ECONNREFUSED");
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fans the secondary sources out concurrently (one Promise.all), not one at a time", async () => {
    const base = timelineFetch({
      caseRecord,
      attempts: [attempt()],
      caseHistory: [caseHistoryRow()],
      assignmentHistory: [assignmentStatusRow()],
      appointments: [appointmentRow()],
      proofItems: [proofItem()],
      effects: [effect()],
      openAttentions: [],
      resolvedAttentions: [],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      // The sequential primary Case lookup (step 1, before the fan-out)
      // is excluded — only the secondary sources prove concurrency.
      const isPrimaryLookup = href.endsWith(`/api/cases/${caseId}`);
      if (!isPrimaryLookup) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield a tick: a serialized (one-await-at-a-time) fan-out would
        // resolve each call before the next one starts, so `maxInFlight`
        // would never exceed 1.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      try {
        return await base(url);
      } finally {
        if (!isPrimaryLookup) inFlight -= 1;
      }
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);

    expect(response.status).toBe(200);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("returns items that validate against the full TimelineEventDtoSchema (contract-drift guard — production deliberately does not parse per item)", async () => {
    const fetchImpl = timelineFetch({
      caseRecord,
      attempts: [attempt()],
      caseHistory: [caseHistoryRow()],
      assignmentHistory: [assignmentStatusRow()],
      appointments: [appointmentRow()],
      proofItems: [proofItem()],
      effects: [effect()],
      openAttentions: [attention()],
      resolvedAttentions: [
        attention({
          id: randomUUID(),
          resolvedAt: "2030-01-08T00:00:00.000Z",
          resolvedByOperationId: "resolve/1",
        }),
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items.length).toBeGreaterThan(0);
    // The route's mappers return `TimelineEvent` (a superset of the
    // contract's `TimelineEventDto`), which TypeScript checks at compile
    // time, but nothing calls `.parse()` on the response at runtime — a
    // mapper drifting from the schema (e.g. a field renamed on one side
    // only) would otherwise ship silently. This test is that guard.
    expect(() =>
      z.array(TimelineEventDtoSchema).parse(body.data.items)
    ).not.toThrow();
  });

  it("marks OFFICER_ATTENTION UNAVAILABLE when either of its two merged atom calls fails, even though the other succeeds", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      if (href.includes("/api/cases/officer-attention")) {
        // `state=open` succeeds; `state=resolved` does not — the atom has no
        // single "all" filter, so this route always issues both.
        if (href.includes("state=resolved")) {
          return new Response("boom", { status: 500 });
        }
        return Response.json({ attentions: [attention()] });
      }
      return Response.json({ cases: [caseRecord] });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/timeline`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.missingSources).toContain("OFFICER_ATTENTION");
    expect(
      body.data.items.some(
        (item: { source: string }) => item.source === "OFFICER_ATTENTION"
      )
    ).toBe(false);
    // Both calls were actually made — the open one's success alone did not
    // let the source through half-populated.
    const attentionCalls = fetchImpl.mock.calls.filter(([url]) =>
      requestHref(url).includes("/api/cases/officer-attention")
    );
    expect(attentionCalls).toHaveLength(2);
  });
});

describe("GET /api/cases/:caseId knock-on: tri-state assignment lookup (PRS-151)", () => {
  // 151-D Task 3 switched the Contractor branch of this route from the
  // current-assignment lookup to the same Attempt-history lookup the
  // timeline uses (`AttemptHistoryLookup`, `FOUND | UNAVAILABLE` — no third
  // ABSENT state, per its own doc comment) — these two tests now exercise
  // that call instead.
  function detailFetch(options: {
    caseRecord?: unknown;
    attemptsThrows?: boolean;
    attempts?: unknown[];
  }): typeof fetch {
    return vi.fn(async (url: RequestInfo | URL) => {
      const href = requestHref(url);
      if (
        href.includes("/api/assignments/by-case/") &&
        href.endsWith("/attempts")
      ) {
        if (options.attemptsThrows) throw new Error("ECONNREFUSED");
        return Response.json({ attempts: options.attempts ?? [] });
      }
      if (href.includes("/api/appointments/")) {
        return Response.json({ appointments: [] });
      }
      if (href.includes("/internal/proof-items/")) {
        return Response.json({ proof: [] });
      }
      if (href.includes("/internal/effects/case/")) {
        return Response.json({ effects: [] });
      }
      return Response.json({
        cases: options.caseRecord ? [options.caseRecord] : [],
      });
    });
  }

  it("returns 503 ASSIGNMENT_ATOM_UNAVAILABLE for a Contractor when the assignment atom is unreachable, instead of a wrong 404", async () => {
    const fetchImpl = detailFetch({ caseRecord, attemptsThrows: true });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("still returns 404 for a Contractor when the Attempt history is reachable but never names this Contractor", async () => {
    const fetchImpl = detailFetch({ caseRecord, attempts: [] });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });
  });
});

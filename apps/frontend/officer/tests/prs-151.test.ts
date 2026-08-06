import type {
  CaseDto,
  TimelineEventSource,
} from "@townops/orchestration-contract";
import { TimelineEventSourceSchema } from "@townops/orchestration-contract";
import type { TimelineEventInput } from "@townops/ui/libr/timeline";
import { toTimelineEvents } from "@townops/ui/libr/timeline";
import { expect, test } from "vitest";

import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

// ---------------------------------------------------------------------------
// toTimelineEvents
// ---------------------------------------------------------------------------

// `noUncheckedIndexedAccess` makes `events[0]` `TimelineEvent | undefined`;
// every one-row case here really does expect exactly one, so assert that
// once here instead of a `?? fail()` at every call site.
function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (!item) throw new Error("unreachable: length checked above");
  return item;
}

function dto(overrides: Partial<TimelineEventInput>): TimelineEventInput {
  return {
    id: "row-1",
    at: "2026-01-01T00:00:00.000Z",
    source: "CASE_HISTORY",
    type: "STATUS_CHANGED",
    actorId: null,
    actorRole: null,
    reason: null,
    operationId: null,
    detail: null,
    ...overrides,
  };
}

// One case per source with `detail: null` — proves each branch of the
// seven-way switch is reachable and produces a non-empty sentence. Keyed as
// `Record<TimelineEventSource, string>` rather than a plain array:
// TypeScript fails to compile this file if the contract ever grows an 8th
// source and this suite is not updated for it — the same
// exhaustive-by-construction idiom `map-case.ts` uses for status/priority.
const sourceCases: Record<TimelineEventSource, string> = {
  CASE_HISTORY: "Case status changed to",
  ALLOCATION_ATTEMPT: "Allocation attempt",
  ASSIGNMENT_STATUS: "Assignment status changed to",
  APPOINTMENT: "Appointment",
  PROOF_ITEM: "proof uploaded",
  DERIVED_EFFECT: "effect recorded",
  OFFICER_ATTENTION: "Officer attention raised",
};

for (const source of TimelineEventSourceSchema.options) {
  const expectContains = sourceCases[source];
  test(`describes a ${source} row with a sensible, non-empty sentence`, () => {
    const event = only(
      toTimelineEvents([dto({ source, type: "SOMETHING", detail: null })])
    );
    expect(event.description.length).toBeGreaterThan(0);
    expect(event.description).toContain(expectContains);
  });
}

// Six of the seven sources also read one specific field out of `detail` for
// a richer sentence (`CASE_HISTORY` does not — it never touches `detail` at
// all). Each case below supplies that field and asserts the resulting
// sentence differs from the `detail: null` case above and contains the
// value that was fed in — proving `detailString` is actually read, not
// just present as dead code. Without this, `sourceCases` above only ever
// exercises the "field absent" arm of each branch.
const detailDrivenCases: Record<
  Exclude<TimelineEventSource, "CASE_HISTORY">,
  { detail: Record<string, unknown>; expectContains: string }
> = {
  ALLOCATION_ATTEMPT: {
    detail: { source: "MANUAL_OVERRIDE" },
    expectContains: "via manual override",
  },
  ASSIGNMENT_STATUS: {
    detail: { fromStatus: "PENDING_ACCEPTANCE" },
    expectContains: "Assignment moved from Pending Acceptance to",
  },
  APPOINTMENT: {
    detail: { startTime: "2026-05-01T09:00:00.000Z" },
    expectContains: "scheduled for",
  },
  PROOF_ITEM: {
    detail: { remarks: "Photo of repaired tap" },
    expectContains: "proof uploaded: Photo of repaired tap",
  },
  DERIVED_EFFECT: {
    detail: { purpose: "RESIDENT_NOTIFICATION" },
    expectContains: "effect queued for resident notification",
  },
  OFFICER_ATTENTION: {
    detail: { detail: "No contractor accepted after 3 attempts" },
    expectContains:
      "Officer attention raised: No contractor accepted after 3 attempts",
  },
};

for (const source of TimelineEventSourceSchema.options) {
  // Control-flow narrowing gives the index below the
  // `Exclude<…, "CASE_HISTORY">` key type for free, with no assertion.
  if (source === "CASE_HISTORY") continue;
  const { detail, expectContains } = detailDrivenCases[source];
  test(`describes a ${source} row using the field it reads out of detail`, () => {
    const withDetail = only(
      toTimelineEvents([dto({ source, type: "SOMETHING", detail })])
    );
    const withoutDetail = only(
      toTimelineEvents([dto({ source, type: "SOMETHING", detail: null })])
    );
    expect(withDetail.description).toContain(expectContains);
    expect(withDetail.description).not.toBe(withoutDetail.description);
  });
}

test("an unknown 8th source does not throw and falls through to the default sentence", () => {
  const events = toTimelineEvents([
    dto({ source: "SOMETHING_NEW_ENTIRELY", type: "WEIRD_TYPE" }),
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]?.description).toBe("Weird Type recorded.");
});

test("`at` lands in the output's `timestamp` field verbatim", () => {
  const event = only(
    toTimelineEvents([dto({ at: "2026-03-04T05:06:07.000Z" })])
  );
  expect(event.timestamp).toBe("2026-03-04T05:06:07.000Z");
});

test("actor fallback: actorRole wins when set", () => {
  const event = only(
    toTimelineEvents([
      dto({
        actorRole: "OFFICER",
        actorId: "11111111-aaaa-bbbb-cccc-222222222222",
      }),
    ])
  );
  expect(event.actor).toBe("OFFICER");
});

test("actor fallback: actorId's first 8 chars when only actorId is set", () => {
  const event = only(
    toTimelineEvents([
      dto({ actorRole: null, actorId: "abcdefgh-ijkl-mnop-qrst-uvwxyz012345" }),
    ])
  );
  expect(event.actor).toBe("abcdefgh");
});

test("actor fallback: 'System' when both actorRole and actorId are null", () => {
  const event = only(
    toTimelineEvents([dto({ actorRole: null, actorId: null })])
  );
  expect(event.actor).toBe("System");
});

test("reason is appended to the description when present", () => {
  const withReason = toTimelineEvents([
    dto({ reason: "Resident requested" }),
  ])[0];
  const withoutReason = toTimelineEvents([dto({ reason: null })])[0];
  expect(withReason?.description).toContain("Reason: Resident requested");
  expect(withoutReason?.description).not.toContain("Reason:");
});

test("preserves input order rather than re-sorting by `at`", () => {
  // Deliberately out of chronological order — a March event before a
  // January one. If `toTimelineEvents` sorted internally, the output order
  // would flip to January-then-March and this would fail.
  const march = dto({ id: "march", at: "2026-03-01T00:00:00.000Z" });
  const january = dto({ id: "january", at: "2026-01-01T00:00:00.000Z" });
  const february = dto({ id: "february", at: "2026-02-01T00:00:00.000Z" });

  const events = toTimelineEvents([march, january, february]);

  expect(events.map((e) => e.timestamp)).toEqual([
    "2026-03-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-02-01T00:00:00.000Z",
  ]);
});

// ---------------------------------------------------------------------------
// mapApiCaseToItem
// ---------------------------------------------------------------------------

const baseCase: CaseDto = {
  id: "case-1",
  residentId: "resident-1",
  category: "LE",
  priority: "MEDIUM",
  status: "PENDING",
  description: "",
  addressDetails: "12 Example Ave",
  postalCode: "123456",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const statusCases: Array<[CaseDto["status"], string]> = [
  ["PENDING", "pending"],
  ["ASSIGNED", "assigned"],
  ["IN_PROGRESS", "in_progress"],
  ["PENDING_RESIDENT_INPUT", "pending_resident_input"],
  ["COMPLETED", "completed"],
  ["CANCELLED", "cancelled"],
];

for (const [gatewayStatus, expected] of statusCases) {
  test(`mapApiCaseToItem maps status ${gatewayStatus} to ${expected}`, () => {
    expect(
      mapApiCaseToItem({ ...baseCase, status: gatewayStatus }).status
    ).toBe(expected);
  });
}

const priorityCases: Array<[CaseDto["priority"], string]> = [
  ["LOW", "low"],
  ["MEDIUM", "medium"],
  ["HIGH", "high"],
  ["EMERGENCY", "emergency"],
];

for (const [gatewayPriority, expected] of priorityCases) {
  test(`mapApiCaseToItem maps priority ${gatewayPriority} to ${expected}`, () => {
    expect(
      mapApiCaseToItem({ ...baseCase, priority: gatewayPriority }).priority
    ).toBe(expected);
  });
}

test("mapApiCaseToItem falls back to postalCode when addressDetails is null", () => {
  const result = mapApiCaseToItem({
    ...baseCase,
    addressDetails: null,
    postalCode: "654321",
  });
  expect(result.address).toBe("654321");
});

test("mapApiCaseToItem lowercases category as well as status/priority", () => {
  expect(mapApiCaseToItem({ ...baseCase, category: "PL" }).category).toBe("pl");
});

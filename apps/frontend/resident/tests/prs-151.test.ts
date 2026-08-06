// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { caseKeys } from "../src/features/case/api/query-keys";
import { getTimeline, listCases } from "../src/libr/gateway";

afterEach(() => vi.restoreAllMocks());

const caseRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  residentId: "33333333-3333-4333-8333-333333333333",
  category: "LE",
  priority: "HIGH",
  status: "ASSIGNED",
  description: "Broken street light",
  addressDetails: null,
  postalCode: "123456",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

test("listCases() parses the envelope and returns the items", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: { items: [caseRecord], page: 1, pageSize: 100 },
    })
  );

  const items = await listCases();

  expect(items).toEqual([caseRecord]);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/cases?pageSize=100"),
    expect.anything()
  );
});

test("listCases() sends no resident id — the Gateway scopes the list from the bearer token", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ data: { items: [], page: 1, pageSize: 100 } })
    );

  await listCases();

  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  const [url, init] = call;
  expect(url).not.toContain("residentId");
  expect(init).not.toHaveProperty("body");
});

test("listCases() rejects with the Gateway's message and code on a 404", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: {
          code: "RESIDENT_NOT_FOUND",
          message: "Resident was not found",
        },
      },
      { status: 404 }
    )
  );

  await expect(listCases()).rejects.toMatchObject({
    message: "Resident was not found",
    code: "RESIDENT_NOT_FOUND",
  });
});

test("getTimeline() maps DTOs through toTimelineEvents and surfaces a populated missingSources", async () => {
  const events = [
    {
      id: "event-1",
      at: "2030-01-01T09:00:00.000Z",
      source: "CASE_HISTORY",
      type: "OPEN",
      actorId: "aaaaaaaa-1111-2222-3333-444444444444",
      actorRole: null,
      reason: null,
      operationId: null,
      detail: null,
    },
    {
      id: "event-2",
      at: "2030-01-02T10:00:00.000Z",
      source: "PROOF_ITEM",
      type: "BEFORE",
      actorId: null,
      actorRole: "CONTRACTOR",
      reason: null,
      operationId: null,
      detail: { remarks: "Leak fixed" },
    },
    {
      id: "event-3",
      at: "2030-01-03T11:00:00.000Z",
      source: "DERIVED_EFFECT",
      type: "WAIVE_ASSIGNMENT",
      actorId: null,
      actorRole: null,
      reason: "Contractor unavailable",
      operationId: null,
      detail: { purpose: "NO_SHOW" },
    },
  ];
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        items: events,
        missingSources: ["OFFICER_ATTENTION", "APPOINTMENT"],
      },
    })
  );

  const result = await getTimeline(caseRecord.id);

  // F4 inverts the old behaviour: `missingSources` used to be parsed and
  // discarded (this test asserted its absence). It is now load-bearing —
  // a caller renders it as a degraded-history warning — so a regression that
  // drops it again, or that stops shaping the return as
  // `{ events, missingSources }`, must fail here.
  expect(result.events).toEqual([
    {
      type: "Open",
      actor: "aaaaaaaa",
      timestamp: "2030-01-01T09:00:00.000Z",
      description: "Case status changed to Open.",
    },
    {
      type: "Before",
      actor: "CONTRACTOR",
      timestamp: "2030-01-02T10:00:00.000Z",
      description: "Before proof uploaded: Leak fixed",
    },
    {
      type: "Waive Assignment",
      actor: "System",
      timestamp: "2030-01-03T11:00:00.000Z",
      description:
        "Waive Assignment effect queued for no show. Reason: Contractor unavailable",
    },
  ]);
  expect(result.missingSources).toEqual(["OFFICER_ATTENTION", "APPOINTMENT"]);
});

test("caseKeys nests detail and timeline under list so invalidating the list also invalidates cached details and timelines", () => {
  const id = "22222222-2222-4222-8222-222222222222";

  expect(caseKeys.list).toEqual(["cases"]);
  expect(caseKeys.detail(id)).toEqual(["cases", id]);
  expect(caseKeys.timeline(id)).toEqual(["cases", id, "timeline"]);

  // Structural prefix check: TanStack Query invalidates by matching a shorter
  // key as a leading prefix of a longer one, so `list` must literally prefix
  // `detail`, and `detail` must literally prefix `timeline`.
  expect(caseKeys.detail(id).slice(0, caseKeys.list.length)).toEqual(
    caseKeys.list
  );
  expect(caseKeys.timeline(id).slice(0, caseKeys.detail(id).length)).toEqual(
    caseKeys.detail(id)
  );
});

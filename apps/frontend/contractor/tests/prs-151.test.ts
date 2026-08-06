// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type {
  CaseDto,
  HistoricalContractorCaseDto,
} from "@townops/orchestration-contract";
import { afterEach, expect, test, vi } from "vitest";

import { env } from "../src/env";
import { caseQueries } from "../src/features/case/api/queries";
import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// caseQueries.all() — the scoping fix (PRS-151, 151-E)
// ---------------------------------------------------------------------------
//
// Before this change the Contractor frontend read `contractorId` off the
// session, fetched the contractor's assignments from the assignment atom,
// then fetched EVERY case in the database and `.filter()`'d in the browser.
// That is the authorization hole PRS-151 closes: the Gateway now scopes
// server-side and the frontend makes exactly one call.

const baseCase: CaseDto = {
  id: "11111111-1111-4111-8111-111111111111",
  residentId: "22222222-2222-4222-8222-222222222222",
  category: "LE",
  priority: "MEDIUM",
  status: "PENDING",
  description: "Broken street light",
  addressDetails: "12 Example Ave",
  postalCode: "123456",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const historicalCase: HistoricalContractorCaseDto = {
  id: "33333333-3333-4333-8333-333333333333",
  category: "PL",
  priority: "HIGH",
  status: "COMPLETED",
  description: "Leaking tap",
  postalSector: "12",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

test("caseQueries.all() issues exactly one request, straight to the Gateway's /api/cases route", async () => {
  // A fresh `Response` per call, not one shared instance — a body can only
  // be read once, so if the regression this test guards against ever comes
  // back (a second, extra fetch), that call gets its own valid response and
  // the test fails on the assertions below for the right reason, instead of
  // on a "body already read" `TypeError` at the `await` above them.
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json({ data: { items: [baseCase] } })
    );

  const qc = new QueryClient();
  await qc.fetchQuery(caseQueries.all());

  // This is what catches a reinstated client-side filter: the old flow
  // needed at least two round trips (assignment atom, then the full case
  // table) — any regression back to it changes this count. A regression
  // to the old *route* (case atom directly, bypassing the Gateway) would
  // still be one call but fail the URL assertion below.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url] = fetchMock.mock.calls[0] ?? [];
  if (typeof url !== "string") throw new Error("expected a string URL");
  expect(url).toBe(`${env.VITE_GATEWAY_URL}/api/cases?pageSize=100`);
  // Belt-and-braces on the same regression: no leftover call shape
  // targeting the assignment atom's contractor-scope route or a bare case
  // atom host.
  expect(url).not.toContain("/contractor/");
  expect(url).not.toContain("/assignments");
});

test("caseQueries.all() parses a heterogeneous list — one CURRENT and one HISTORICAL case — and keeps both", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ data: { items: [baseCase, historicalCase] } })
  );

  const qc = new QueryClient();
  const items = await qc.fetchQuery(caseQueries.all());

  // Would fail if the union dropped the historical row (e.g. `z.union`
  // ordering flipped, or the historical schema regressed to require a
  // field only CURRENT rows carry) instead of parsing it via
  // `HistoricalContractorCaseDtoSchema`.
  expect(items.map((item) => item.id)).toEqual([
    baseCase.id,
    historicalCase.id,
  ]);
  // The historical row parsed through the narrowed schema, not silently
  // coerced through `CaseDtoSchema` — its missing Resident identity comes
  // through as the app's own "" fallback, not a leaked/invented uuid.
  expect(items[1]?.residentId).toBe("");
});

// ---------------------------------------------------------------------------
// mapApiCaseToItem
// ---------------------------------------------------------------------------

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

test("mapApiCaseToItem maps a HistoricalContractorCaseDto (no residentId/addressDetails/postalCode) without throwing", () => {
  const result = mapApiCaseToItem(historicalCase);

  expect(result.id).toBe(historicalCase.id);
  expect(result.status).toBe("completed");
  expect(result.priority).toBe("high");
});

test("mapApiCaseToItem falls back to residentId '' for a historical case that carries no Resident identity", () => {
  expect(mapApiCaseToItem(historicalCase).residentId).toBe("");
});

test("mapApiCaseToItem falls back to postalSector for address on a historical case (no addressDetails/postalCode field to prefer)", () => {
  expect(mapApiCaseToItem(historicalCase).address).toBe(
    historicalCase.postalSector
  );
});

test("mapApiCaseToItem still prefers addressDetails over postalCode on a CURRENT case", () => {
  expect(mapApiCaseToItem(baseCase).address).toBe(baseCase.addressDetails);
});

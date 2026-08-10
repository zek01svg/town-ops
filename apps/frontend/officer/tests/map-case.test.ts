import type { CaseDto } from "@townops/orchestration-contract";
import { expect, test } from "vitest";

import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

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

test("maps an empty case description to undefined", () => {
  expect(mapApiCaseToItem({ ...baseCase, description: "" })).toMatchObject({
    id: "case-1",
    description: undefined,
  });
});

test("maps a non-empty description through unchanged", () => {
  expect(
    mapApiCaseToItem({ ...baseCase, description: "Leaking tap" })
  ).toMatchObject({
    description: "Leaking tap",
  });
});

// Proves the uppercase Gateway enum -> lowercase app union boundary actually
// runs here, rather than only via the exhaustive matrix in prs-151.test.ts.
// If the STATUS/PRIORITY/category mapping were removed (fields passed
// through as-is), each field below would still read "PENDING_RESIDENT_
// INPUT"/"HIGH"/"LE" and every assertion would fail.
test("lowercases the Gateway's UPPERCASE status, priority and category", () => {
  const result = mapApiCaseToItem({
    ...baseCase,
    status: "PENDING_RESIDENT_INPUT",
    priority: "HIGH",
    category: "LE",
  });
  expect(result.status).toBe("pending_resident_input");
  expect(result.priority).toBe("high");
  expect(result.category).toBe("le");
});

test("falls back to postalCode when addressDetails is null", () => {
  const result = mapApiCaseToItem({
    ...baseCase,
    addressDetails: null,
    postalCode: "654321",
  });
  expect(result.address).toBe("654321");
});

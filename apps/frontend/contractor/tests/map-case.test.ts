import type { CaseDto } from "@townops/orchestration-contract";
import { expect, test } from "vitest";

import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

const baseCase: CaseDto = {
  id: "11111111-1111-4111-8111-111111111111",
  residentId: "22222222-2222-4222-8222-222222222222",
  category: "PL",
  priority: "MEDIUM",
  status: "PENDING",
  description: "",
  addressDetails: "12 Example Ave",
  postalCode: "123456",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};

// `createdAt`/`updatedAt` are the DTO's actual nullable fields (`z.string().nullable()`
// on `CaseDtoSchema`) — the fallback the original fixture's `description: null`
// no longer exercises now that `description` is a required `string`.
// `case-audit-trail.tsx:318` does `new Date(caseData.createdAt).toLocaleString()`,
// so a regression here degrades to a rendered "Invalid Date" instead of throwing.
test("maps a null createdAt/updatedAt to an empty display value", () => {
  const caseItem = mapApiCaseToItem({
    ...baseCase,
    createdAt: null,
    updatedAt: null,
  });

  expect(caseItem.createdAt).toBe("");
  expect(caseItem.updatedAt).toBe("");
});

// Regression guard for `case-audit-trail.tsx`'s Complete-button gate
// (`caseData?.status === "in_progress"`), which compares the mapped item
// against this lowercase literal. If the Gateway's uppercase -> app
// lowercase mapping regresses (e.g. the `STATUS` Record loses an entry or
// starts passing the raw value through), the gate silently goes false
// forever and Complete never enables — this fails loudly instead.
test("lowercases the Gateway's uppercase status so the downstream gating literal still matches", () => {
  const caseItem = mapApiCaseToItem({ ...baseCase, status: "IN_PROGRESS" });

  expect(caseItem.status).toBe("in_progress");
});

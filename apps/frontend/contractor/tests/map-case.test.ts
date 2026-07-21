import { expect, test } from "vitest";

import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

test("maps a nullable case description to an empty display value", () => {
  const caseItem = mapApiCaseToItem({
    id: "case-1",
    resident_id: "resident-1",
    category: "plumbing",
    priority: "medium",
    status: "pending",
    description: null,
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  });

  expect(caseItem.description).toBe("");
});

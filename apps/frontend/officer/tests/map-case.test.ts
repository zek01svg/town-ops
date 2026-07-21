import { expect, test } from "vitest";

import { mapApiCaseToItem } from "../src/features/case/lib/map-case";

test("maps a nullable case description to undefined", () => {
  expect(
    mapApiCaseToItem({
      id: "case-1",
      resident_id: "resident-1",
      category: "LE",
      priority: "medium",
      status: "pending",
      description: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  ).toMatchObject({
    id: "case-1",
    description: undefined,
  });
});

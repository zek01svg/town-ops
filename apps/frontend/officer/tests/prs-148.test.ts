// @vitest-environment jsdom

import { expect, test } from "vitest";

import { isCaseCancellable } from "../src/features/case/components/case-audit-trail";

test("only exposes cancellation before work starts or a Case becomes terminal", () => {
  expect(isCaseCancellable("pending")).toBe(true);
  expect(isCaseCancellable("assigned")).toBe(true);
  expect(isCaseCancellable("pending_resident_input")).toBe(true);
  expect(isCaseCancellable("in_progress")).toBe(false);
  expect(isCaseCancellable("completed")).toBe(false);
  expect(isCaseCancellable("cancelled")).toBe(false);
});

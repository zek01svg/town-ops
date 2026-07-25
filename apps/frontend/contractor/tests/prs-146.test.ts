// @vitest-environment jsdom

import { expect, test } from "vitest";

import { noAccessBlocker } from "../src/features/case/components/case-audit-trail";

const appointment = {
  id: "appointment-1",
  contractorId: "contractor-1",
  status: "SCHEDULED",
  startTime: new Date(Date.now() - 60_000).toISOString(),
  endTime: new Date(Date.now() + 60_000).toISOString(),
};

test("disables No Access after work has started", () => {
  expect(
    noAccessBlocker(
      { ...appointment, status: "IN_PROGRESS" },
      appointment.contractorId
    )
  ).toContain("only a scheduled visit");
});

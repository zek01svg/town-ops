// @vitest-environment jsdom

import { expect, test } from "vitest";

import { rescheduleBlocker } from "../src/features/case/components/case-audit-trail";

const interval = {
  startTime: new Date(Date.now() + 60_000).toISOString(),
  endTime: new Date(Date.now() + 120_000).toISOString(),
};

test("requires a reason for a proactive reschedule but not No Access recovery", () => {
  expect(
    rescheduleBlocker(
      { id: "appointment-1", status: "SCHEDULED", ...interval, reason: null },
      interval.startTime,
      interval.endTime,
      "",
      false
    )
  ).toBe("A reason is required to move a scheduled visit.");
  expect(
    rescheduleBlocker(
      { id: "appointment-1", status: "NO_ACCESS", ...interval, reason: null },
      interval.startTime,
      interval.endTime,
      "",
      false
    )
  ).toBeNull();
});

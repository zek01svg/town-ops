// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { rescheduleBlocker } from "../src/features/dashboard/resident/resident-dashboard";
import { getCase } from "../src/libr/gateway";

const interval = {
  startTime: new Date(Date.now() + 60_000).toISOString(),
  endTime: new Date(Date.now() + 120_000).toISOString(),
};

afterEach(() => vi.restoreAllMocks());

test("accepts a reasonless No Access recovery", () => {
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

test("consumes the Resident's flat Case response", async () => {
  const appointment = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "NO_ACCESS",
    ...interval,
    reason: null,
  } as const;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        residentId: "33333333-3333-4333-8333-333333333333",
        category: "LE",
        priority: "HIGH",
        status: "PENDING_RESIDENT_INPUT",
        description: "Broken street light",
        addressDetails: null,
        postalCode: "123456",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        appointment,
      },
    })
  );

  const caseRecord = await getCase("22222222-2222-4222-8222-222222222222");

  expect(caseRecord.appointment).toEqual(appointment);
  expect(caseRecord).not.toHaveProperty("assignment");
});

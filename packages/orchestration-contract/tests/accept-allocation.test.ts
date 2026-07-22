import { describe, expect, it } from "vitest";

import {
  AcceptAllocationInputSchema,
  canonicalAcceptAllocationPayload,
} from "../src/index";
import type { AcceptAllocationInput } from "../src/index";

describe("accept-allocation contract", () => {
  const caseId = "123e4567-e89b-12d3-a456-426614174000";
  const attemptId = "223e4567-e89b-12d3-a456-426614174001";
  const input: AcceptAllocationInput = {
    startTime: "2030-01-01T10:00:00.000Z",
    endTime: "2030-01-01T12:00:00.000Z",
  };

  it("accepts a half-open Appointment interval and canonicalizes it for retries", () => {
    expect(AcceptAllocationInputSchema.safeParse(input).success).toBe(true);
    expect(canonicalAcceptAllocationPayload(caseId, attemptId, input)).toBe(
      JSON.stringify({
        caseId,
        attemptId,
        startTime: input.startTime,
        endTime: input.endTime,
      })
    );
  });

  it("rejects an Appointment interval whose end is not after its start", () => {
    expect(
      AcceptAllocationInputSchema.safeParse({
        ...input,
        endTime: input.startTime,
      }).success
    ).toBe(false);
  });
});

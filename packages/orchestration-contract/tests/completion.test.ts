import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_COMPLETED_SCORE_DELTA,
  AppointmentStatusSchema,
  canonicalCompletionPayload,
  CompletionInputSchema,
  CompleteCaseResultSchema,
} from "../src/index";

describe("completion contract (PRS-147)", () => {
  const caseId = "123e4567-e89b-12d3-a456-426614174000";
  const beforeId = "223e4567-e89b-12d3-a456-426614174001";
  const afterId = "323e4567-e89b-12d3-a456-426614174002";

  it("normalizes the report and distinct proof IDs for idempotency", () => {
    const input = CompletionInputSchema.parse({
      report: "  Repair completed.  ",
      proofItemIds: [afterId, beforeId, afterId],
    });
    expect(canonicalCompletionPayload(caseId, input)).toBe(
      JSON.stringify({
        caseId,
        report: "Repair completed.",
        proofItemIds: [beforeId, afterId].toSorted(),
      })
    );
  });

  it("requires a nonempty report and exposes completed status and reward", () => {
    expect(
      CompletionInputSchema.safeParse({
        report: "  ",
        proofItemIds: [beforeId],
      }).success
    ).toBe(false);
    expect(AppointmentStatusSchema.safeParse("COMPLETED").success).toBe(true);
    expect(ASSIGNMENT_COMPLETED_SCORE_DELTA).toBe(10);
  });

  it("keeps completion outcomes explicit", () => {
    for (const kind of [
      "NOT_IN_PROGRESS",
      "COMPLETION_INVALID",
      "COMPLETION_FAILED",
    ]) {
      expect(CompleteCaseResultSchema.safeParse({ kind }).success).toBe(true);
    }
  });
});

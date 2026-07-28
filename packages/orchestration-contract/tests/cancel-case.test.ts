import {
  CancelCaseCommandSchema,
  CancelCaseInputSchema,
  canonicalCancelCasePayload,
} from "@townops/orchestration-contract";
import { describe, expect, it } from "vitest";

describe("cancel Case contract (PRS-148)", () => {
  it("trims the required reason in the canonical idempotency payload", () => {
    const caseId = "11111111-1111-4111-8111-111111111111";
    const input = CancelCaseInputSchema.parse({
      reason: "  no longer needed  ",
    });

    expect(input.reason).toBe("no longer needed");
    expect(canonicalCancelCasePayload(caseId, input)).toBe(
      JSON.stringify({ caseId, reason: "no longer needed" })
    );
  });

  it("allows only Resident and Officer cancellation commands", () => {
    const command = {
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      payloadHash: "a".repeat(64),
      operationId: "cancel/1",
      actorId: "33333333-3333-4333-8333-333333333333",
      caseId: "44444444-4444-4444-8444-444444444444",
      input: { reason: "No longer needed" },
    };

    expect(
      CancelCaseCommandSchema.safeParse({ ...command, actorRole: "RESIDENT" })
        .success
    ).toBe(true);
    expect(
      CancelCaseCommandSchema.safeParse({ ...command, actorRole: "OFFICER" })
        .success
    ).toBe(true);
    expect(
      CancelCaseCommandSchema.safeParse({ ...command, actorRole: "CONTRACTOR" })
        .success
    ).toBe(false);
  });
});

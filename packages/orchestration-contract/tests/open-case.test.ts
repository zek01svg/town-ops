import { describe, expect, it } from "vitest";

import {
  OpenCaseInputSchema,
  canonicalOpenCasePayload,
  caseWorkflowId,
} from "../src/index";
import type { OpenCaseInput } from "../src/index";

describe("open-case contract", () => {
  const input: OpenCaseInput = {
    residentId: "123e4567-e89b-12d3-a456-426614174000",
    category: "PL",
    priority: "HIGH",
    description: "Leaking tap",
    addressDetails: "Floor 2",
    postalCode: "560123",
  };

  it("accepts the public Case-opening input and produces a stable workflow identity", () => {
    expect(OpenCaseInputSchema.safeParse(input).success).toBe(true);
    expect(caseWorkflowId("123e4567-e89b-12d3-a456-426614174001")).toBe(
      "case/123e4567-e89b-12d3-a456-426614174001"
    );
  });

  it("rejects malformed public input and canonicalizes a retry payload", () => {
    expect(
      OpenCaseInputSchema.safeParse({ ...input, postalCode: "not-a-code" })
        .success
    ).toBe(false);
    expect(canonicalOpenCasePayload(input)).toBe(
      JSON.stringify({
        residentId: input.residentId,
        category: input.category,
        priority: input.priority,
        description: input.description,
        addressDetails: input.addressDetails,
        postalCode: input.postalCode,
      })
    );
  });
});

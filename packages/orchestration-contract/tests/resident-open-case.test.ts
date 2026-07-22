import { describe, expect, it } from "vitest";

import { ResidentOpenCaseInputSchema } from "../src/index";

describe("Resident open-case contract", () => {
  const residentBody = {
    category: "PL" as const,
    priority: "HIGH" as const,
    description: "Leaking tap",
    postalCode: "560123",
  };

  it("accepts a valid Resident-submitted body without a residentId", () => {
    expect(ResidentOpenCaseInputSchema.safeParse(residentBody).success).toBe(
      true
    );
  });

  it("rejects a body carrying a residentId as privilege-field injection -- the Gateway relies on this strictness to block Residents from opening a Case on another Resident's behalf", () => {
    const result = ResidentOpenCaseInputSchema.safeParse({
      ...residentBody,
      residentId: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { ProvisionResidentInputSchema } from "../src/index";

describe("Resident provisioning contract", () => {
  const validInput = {
    accountId: "123e4567-e89b-12d3-a456-426614174000",
    fullName: "Rae Resident",
    email: "rae@example.com",
  };

  it("accepts exactly {accountId, fullName, email}", () => {
    expect(ProvisionResidentInputSchema.safeParse(validInput).success).toBe(
      true
    );
  });

  it("rejects a password field so credentials can never reach Workflow history", () => {
    const result = ProvisionResidentInputSchema.safeParse({
      ...validInput,
      password: "hunter22",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a token field so credentials can never reach Workflow history", () => {
    const result = ProvisionResidentInputSchema.safeParse({
      ...validInput,
      token: "some-jwt",
    });

    expect(result.success).toBe(false);
  });
});

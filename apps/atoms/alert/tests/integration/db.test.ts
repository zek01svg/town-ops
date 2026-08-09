import { describe, it, expect } from "vitest";

import { reserveEffect } from "../../src/service";

describe("Database Integration Tests", () => {
  it("rejects a reused effect ID when the immutable email payload differs", async () => {
    const effect = {
      id: "attempt-immutable/assignment-notification",
      caseId: "123e4567-e89b-12d3-a456-426614174000",
      type: "EMAIL" as const,
      purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION" as const,
      payload: {
        type: "EMAIL" as const,
        to: "contractor@example.com",
        subject: "TownOps: Job Assigned",
        html: "<p>Original</p>",
      },
    };

    await reserveEffect(effect);

    await expect(
      reserveEffect({
        ...effect,
        payload: { ...effect.payload, html: "<p>Changed</p>" },
      })
    ).rejects.toThrow("immutable effect");
  });
});

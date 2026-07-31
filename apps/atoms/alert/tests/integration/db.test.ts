import { describe, it, expect } from "vitest";

import db from "../../src/database/db";
import { alerts } from "../../src/database/schema";
import { reserveEffect } from "../../src/service";

describe("Database Integration Tests", () => {
  it("should connect to the test container and insert an alert", async () => {
    // Arrange
    const payload = {
      caseId: "123e4567-e89b-12d3-a456-426614174000",
      recipientId: "223e4567-e89b-12d3-a456-426614174002",
      channel: "email" as const,
      message: "Test Integration Alert via container DB",
    };

    // Act
    const result = await db.insert(alerts).values(payload).returning();

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("id");
    expect(result[0].message).toBe(payload.message);

    // Verify querying
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(payload.message);
  });

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

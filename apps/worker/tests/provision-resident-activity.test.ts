import { randomUUID } from "node:crypto";

import type { ProvisionResidentInput } from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createProvisionResidentActivity } from "../src/activities/provision-resident";

const input: ProvisionResidentInput = {
  accountId: randomUUID(),
  fullName: "Rae Resident",
  email: "rae@example.com",
};
const workerServiceToken = "a".repeat(32);

describe("provisionResidentProfile Activity", () => {
  it("sends the Bearer token and exactly {accountId, fullName, email}, no extra fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        { resident: { id: input.accountId, ...input } },
        { status: 201 }
      )
    );
    const provisionResidentProfile = createProvisionResidentActivity({
      residentAtomUrl: "http://resident-atom:5008",
      workerServiceToken,
      fetchImpl,
    });

    await expect(provisionResidentProfile(input)).resolves.toMatchObject({
      id: input.accountId,
      fullName: input.fullName,
      email: input.email,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://resident-atom:5008/internal/residents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerServiceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }
    );
    const [, options] = fetchImpl.mock.calls[0];
    expect(Object.keys(JSON.parse(options.body as string)).toSorted()).toEqual([
      "accountId",
      "email",
      "fullName",
    ]);
  });

  it("treats a 4xx Resident atom response as a non-retryable ApplicationFailure", async () => {
    const provisionResidentProfile = createProvisionResidentActivity({
      residentAtomUrl: "http://resident-atom:5008",
      workerServiceToken,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "conflict" }, { status: 409 })
        ),
    });

    await expect(provisionResidentProfile(input)).rejects.toMatchObject({
      type: "RESIDENT_PROVISIONING_REJECTED",
      nonRetryable: true,
    });
  });

  it("throws a plain retryable error on a 5xx Resident atom response", async () => {
    const provisionResidentProfile = createProvisionResidentActivity({
      residentAtomUrl: "http://resident-atom:5008",
      workerServiceToken,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(new Response("upstream failure", { status: 502 })),
    });

    const rejection = provisionResidentProfile(input);
    await expect(rejection).rejects.toThrow(/502/);
    await expect(rejection).rejects.not.toMatchObject({
      nonRetryable: true,
    });
  });
});

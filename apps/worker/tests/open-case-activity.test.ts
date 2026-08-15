import { randomUUID } from "node:crypto";

import type { CreateCaseActivityInput } from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createOpenCaseActivity } from "../src/activities/open-case";

const input: CreateCaseActivityInput = {
  caseId: randomUUID(),
  operationId: "operation-1",
  actorId: "4b0a6c4d-3a9b-4d6b-aebe-123456789abc",
  actorRole: "OFFICER",
  input: {
    residentId: "a3d4d1c2-5555-4e66-8e77-123456789abc",
    category: "LE",
    priority: "HIGH",
    description: "Broken street light",
    postalCode: "123456",
  },
};
const workerServiceToken = "a".repeat(32);

describe("openCase Activity", () => {
  it("requires an existing Resident and maps the atom result to the public Case", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ residents: [{ id: input.input.residentId }] })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            case: {
              id: input.caseId,
              residentId: input.input.residentId,
              category: "LE",
              priority: "high",
              status: "pending",
              description: input.input.description,
              addressDetails: null,
              postalCode: input.input.postalCode,
              createdAt: "2026-07-21T00:00:00.000Z",
              updatedAt: "2026-07-21T00:00:00.000Z",
            },
          },
          { status: 201 }
        )
      );
    const openCase = createOpenCaseActivity({
      residentAtomUrl: "http://resident-atom:5008",
      caseAtomUrl: "http://case-atom:5005",
      workerServiceToken,
      fetchImpl,
    });

    await expect(openCase(input)).resolves.toMatchObject({
      id: input.caseId,
      priority: "HIGH",
      status: "PENDING",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://resident-atom:5008/api/residents/" + input.input.residentId,
      { headers: { Authorization: `Bearer ${workerServiceToken}` } }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://case-atom:5005/internal/cases",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerServiceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    );
  });

  it("attaches X-Serverless-Authorization alongside Authorization when a minter is injected (PRS-140 Phase 5)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ residents: [] }));
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");
    const openCase = createOpenCaseActivity({
      residentAtomUrl: "http://resident-atom:5008",
      caseAtomUrl: "http://case-atom:5005",
      workerServiceToken,
      fetchImpl,
      mintIdentityToken,
    });

    await expect(openCase(input)).rejects.toMatchObject({
      type: "RESIDENT_NOT_FOUND",
    });

    const [, initArg] = fetchImpl.mock.calls[0];
    const headers = new Headers(initArg?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith("http://resident-atom:5008");
  });

  it("fails permanently when the Resident is absent", async () => {
    const openCase = createOpenCaseActivity({
      residentAtomUrl: "http://resident-atom:5008",
      caseAtomUrl: "http://case-atom:5005",
      workerServiceToken,
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ residents: [] })),
    });

    await expect(openCase(input)).rejects.toMatchObject({
      type: "RESIDENT_NOT_FOUND",
    });
  });
});

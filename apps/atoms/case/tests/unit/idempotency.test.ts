import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCaseForOperation } from "../../src/service";

const { tx, db } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5005";
  process.env.WORKER_SERVICE_TOKEN = "a".repeat(32);

  const tx = {
    insert: vi.fn(),
    select: vi.fn(),
  };

  return {
    tx,
    db: {
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx)
      ),
    },
  };
});

vi.mock("../../src/database/db", () => ({ default: db }));

describe("createCaseForOperation", () => {
  const input = {
    caseId: "123e4567-e89b-12d3-a456-426614174000",
    operationId: "case/123e4567-e89b-12d3-a456-426614174000/open",
    actorId: "123e4567-e89b-12d3-a456-426614174001",
    actorRole: "OFFICER" as const,
    input: {
      residentId: "123e4567-e89b-12d3-a456-426614174002",
      category: "PL" as const,
      priority: "HIGH" as const,
      description: "Leaking tap",
      postalCode: "560123",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the Case, opening history, and operation in one transaction", async () => {
    const createdCase = {
      id: input.caseId,
      residentId: input.input.residentId,
      category: input.input.category,
      priority: "high",
      status: "pending",
      description: input.input.description,
      addressDetails: null,
      postalCode: input.input.postalCode,
      createdAt: null,
      updatedAt: null,
    };

    tx.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ caseId: input.caseId }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdCase]),
        }),
      })
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) });

    await expect(createCaseForOperation(input)).resolves.toEqual(createdCase);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledTimes(3);
  });

  it("returns the original Case when the operation has already committed", async () => {
    const existingCase = { id: input.caseId, status: "pending" };

    tx.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    tx.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ caseId: input.caseId }]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([existingCase]),
        }),
      });

    await expect(createCaseForOperation(input)).resolves.toEqual(existingCase);
    expect(tx.insert).toHaveBeenCalledOnce();
  });
});

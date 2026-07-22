import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureResidentProfile } from "../../src/service";

const { db } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.PORT = "5008";
  process.env.WORKER_SERVICE_TOKEN = "a".repeat(32);

  return {
    db: {
      insert: vi.fn(),
      select: vi.fn(),
    },
  };
});

vi.mock("../../src/database/db", () => ({ default: db }));

describe("ensureResidentProfile", () => {
  const input = {
    accountId: "123e4567-e89b-12d3-a456-426614174000",
    fullName: "Rae Resident",
    email: "rae@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the newly created row on a fresh insert", async () => {
    const createdRow = {
      id: input.accountId,
      fullName: input.fullName,
      email: input.email,
    };
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdRow]),
        }),
      }),
    });

    await expect(ensureResidentProfile(input)).resolves.toEqual(createdRow);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("is idempotent under repeated provisioning: a conflicting insert falls back to the existing row selected by Account ID", async () => {
    const existingRow = {
      id: input.accountId,
      fullName: input.fullName,
      email: input.email,
    };
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([existingRow]),
      }),
    });

    await expect(ensureResidentProfile(input)).resolves.toEqual(existingRow);
  });

  it("returns null when the insert conflicts and no row owns the Account ID -- the email already belongs to a different Account", async () => {
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(ensureResidentProfile(input)).resolves.toBeNull();
  });
});

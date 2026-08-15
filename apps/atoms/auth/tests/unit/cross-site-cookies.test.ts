import { describe, it, expect, vi } from "vitest";

// A separate file from index.test.ts on purpose: `auth.ts` reads
// BETTER_AUTH_URL once at module load, and vitest's module registry is
// per-file, so the deployed (https) branch can only be exercised in a file
// that sets a different value before the import evaluates. index.test.ts
// covers the localhost (http) branch.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://root:password@localhost:5432/testdb";
  process.env.BETTER_AUTH_SECRET = "8183b03d6053e0f618df1ba7b99bdb7f";
  process.env.BETTER_AUTH_URL = "https://gateway.example";
  process.env.PORT = "5001";
});

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../src/database/db", () => ({ default: dbMock }));

const { auth } = await import("../../src/auth");

describe("cross-site session cookies", () => {
  it("sends the session cookie cross-site when BETTER_AUTH_URL is https", () => {
    // Deployed, the cookie is set on the Gateway's run.app host while the
    // browser's origin is a frontend's run.app host. `run.app` is on the
    // Public Suffix List, so those are cross-SITE, and Better Auth's default
    // SameSite=Lax cookie is never attached to the frontend's XHR -- every
    // login silently fails in a browser while passing every curl-based check.
    expect(auth.options.advanced?.defaultCookieAttributes).toEqual({
      sameSite: "none",
      secure: true,
    });
  });
});

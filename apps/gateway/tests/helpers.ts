import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { vi } from "vitest";

import { createGatewayApp } from "../src/app";

export const officerId = "4b0a6c4d-3a9b-4d6b-aebe-123456789abc";
export const residentId = "a3d4d1c2-5555-4e66-8e77-123456789abc";
export const otherResidentId = "b7c8d1c2-6666-4e66-8e77-123456789abc";
export const workerServiceToken = "gateway-worker-service-token";

export const officerAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", { sub: officerId, role: "officer" });
  await next();
};
export const residentAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: residentId,
    role: "resident",
    name: "Rae Resident",
    email: "rae@example.com",
  });
  await next();
};
export const rejectingAuth: MiddlewareHandler = async (c) => {
  return c.json({ error: { code: "INVALID_TOKEN" } }, 401);
};
/**
 * The production `authenticate` middleware is `hono/jwk`'s `jwk()`, which
 * rejects a missing/invalid token by *throwing* an `HTTPException` rather
 * than returning a Response — unlike `rejectingAuth` above. This exercises
 * the same path so `app.onError()`'s `HTTPException` special-case (PRS-151)
 * is proven against a real throw, not just read from the `hono/jwk` source.
 */
export const throwingUnauthorizedAuth: MiddlewareHandler = async () => {
  throw new HTTPException(401, { message: "Unauthorized" });
};

export const validBody = {
  residentId,
  category: "LE",
  priority: "HIGH",
  description: "Broken street light",
  postalCode: "123456",
};
export const successResult = {
  kind: "SUCCESS" as const,
  data: {
    id: "0ed5b7cc-b070-4e72-86b5-123456789abc",
    ...validBody,
    status: "PENDING" as const,
    addressDetails: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  },
};

export type StartMock = ReturnType<
  typeof vi.fn<
    (
      workflowType: string,
      options: { args?: readonly unknown[] }
    ) => Promise<unknown>
  >
>;

/** A `fetch` stub resolving to one prepared Response, with no type assertion. */
export function fetchResolving(response: Response): typeof fetch {
  return vi.fn(async () => response);
}

export function createApp(
  executeUpdateWithStart = vi.fn().mockResolvedValue(successResult),
  fetchImpl?: typeof fetch,
  overrides: {
    authenticate?: MiddlewareHandler;
    start?: StartMock;
  } = {}
) {
  const start: StartMock =
    overrides.start ?? vi.fn().mockResolvedValue(undefined);
  return {
    app: createGatewayApp({
      authenticate: overrides.authenticate ?? officerAuth,
      workflowClient: { executeUpdateWithStart, start },
      caseAtomUrl: "http://case-atom:5005",
      residentAtomUrl: "http://resident-atom:5008",
      authAtomUrl: "http://auth-atom:5001",
      workerServiceToken,
      fetchImpl,
      updateTimeoutMs: 1,
    }),
    executeUpdateWithStart,
    start,
  };
}

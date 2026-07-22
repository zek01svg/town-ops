import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createGatewayApp } from "../src/app";

const officerId = "4b0a6c4d-3a9b-4d6b-aebe-123456789abc";
const residentId = "a3d4d1c2-5555-4e66-8e77-123456789abc";
const otherResidentId = "b7c8d1c2-6666-4e66-8e77-123456789abc";
const officerAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", { sub: officerId, role: "officer" });
  await next();
};
const residentAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: residentId,
    role: "resident",
    name: "Rae Resident",
    email: "rae@example.com",
  });
  await next();
};
const rejectingAuth: MiddlewareHandler = async (c) => {
  return c.json({ error: { code: "INVALID_TOKEN" } }, 401);
};

const validBody = {
  residentId,
  category: "LE",
  priority: "HIGH",
  description: "Broken street light",
  postalCode: "123456",
};
const successResult = {
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

type StartMock = ReturnType<
  typeof vi.fn<(workflowType: string, options: any) => Promise<unknown>>
>;

function createApp(
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
      fetchImpl,
      updateTimeoutMs: 1,
    }),
    executeUpdateWithStart,
    start,
  };
}

describe("Gateway open Case endpoint", () => {
  it("allows browser preflight from a Compose frontend", async () => {
    const { app } = createApp();

    const response = await app.request("/api/cases", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3001",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,idempotency-key",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3001"
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Idempotency-Key"
    );
  });

  it("validates public input before reaching Temporal", async () => {
    const { app, executeUpdateWithStart } = createApp();

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...validBody, postalCode: "not-a-postal-code" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("sends a deterministic Update-With-Start and returns its Case envelope", async () => {
    const { app, executeUpdateWithStart } = createApp();
    const idempotencyKey = randomUUID();

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ data: { status: "PENDING" } });
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "openCase",
      expect.objectContaining({
        updateId: expect.stringMatching(
          new RegExp(`^${idempotencyKey}\\.[a-f0-9]{64}$`)
        ),
      })
    );
  });

  it("returns a pending envelope on timeout and reattaches with the same operation", async () => {
    let finishFirst: ((value: typeof successResult) => void) | undefined;
    const pending = new Promise<typeof successResult>((resolve) => {
      finishFirst = resolve;
    });
    const executeUpdateWithStart = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(successResult);
    const { app } = createApp(executeUpdateWithStart);
    const idempotencyKey = randomUUID();

    const timedOut = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    const reattached = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });

    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({
      error: {
        code: "WORKFLOW_UPDATE_PENDING",
        retryable: true,
        operation: expect.any(Object),
      },
    });
    expect(reattached.status).toBe(201);
    expect(executeUpdateWithStart.mock.calls[0][1].updateId).toBe(
      executeUpdateWithStart.mock.calls[1][1].updateId
    );
    finishFirst?.(successResult);
  });

  it("returns a retryable error when Temporal is unavailable", async () => {
    const unavailable = Object.assign(new Error("service unavailable"), {
      code: 14,
    });
    const { app } = createApp(vi.fn().mockRejectedValue(unavailable));

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TEMPORAL_UNAVAILABLE", retryable: true },
    });
  });

  it("reads the Case from its atom without touching Temporal history", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        cases: [
          {
            ...successResult.data,
            priority: "high",
            status: "pending",
          },
        ],
      })
    );
    const { app, executeUpdateWithStart } = createApp(undefined, fetchImpl);

    const response = await app.request("/api/cases/" + successResult.data.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { priority: "HIGH", status: "PENDING" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://case-atom:5005/api/cases/" + successResult.data.id
    );
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });
});

describe("Gateway Resident ownership and privilege boundaries", () => {
  const residentBody = {
    category: "LE",
    priority: "HIGH",
    description: "Broken street light",
    postalCode: "123456",
  };
  const residentFoundFetch = () =>
    vi
      .fn()
      .mockResolvedValue(Response.json({ residents: [{ id: residentId }] }));
  const residentAbsentFetch = () =>
    vi.fn().mockResolvedValue(Response.json({ residents: [] }));

  it("rejects a Resident-supplied residentId as a privilege-field injection", async () => {
    const { app, executeUpdateWithStart } = createApp(
      undefined,
      residentFoundFetch(),
      { authenticate: residentAuth }
    );

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...residentBody, residentId: otherResidentId }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("opens a Resident's Case with residentId and actorRole derived from the JWT, never the body", async () => {
    const { app, executeUpdateWithStart } = createApp(
      undefined,
      residentFoundFetch(),
      { authenticate: residentAuth }
    );

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(residentBody),
    });

    expect(response.status).toBe(201);
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "openCase",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorId: residentId,
            actorRole: "RESIDENT",
            input: expect.objectContaining({ residentId }),
          }),
        ],
      })
    );
  });

  it("hides existence of another Resident's Case but returns it for the Resident's own Case", async () => {
    const otherCase = { ...successResult.data, residentId: otherResidentId };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ cases: [otherCase] }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const hidden = await app.request("/api/cases/" + successResult.data.id);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND" },
    });

    fetchImpl.mockResolvedValue(
      Response.json({ cases: [{ ...successResult.data, residentId }] })
    );
    const own = await app.request("/api/cases/" + successResult.data.id);
    expect(own.status).toBe(200);
  });

  it("blocks Case opening while the Resident profile is still provisioning and nudges provisioning", async () => {
    const { app, executeUpdateWithStart, start } = createApp(
      undefined,
      residentAbsentFetch(),
      { authenticate: residentAuth }
    );

    const response = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(residentBody),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "RESIDENT_PROFILE_PROVISIONING", retryable: true },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });
});

describe("GET /api/me", () => {
  it("reports PROVISIONED and canOpenCases for a Resident with an existing profile", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ residents: [{ id: residentId }] }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        accountId: residentId,
        provisioningState: "PROVISIONED",
        canOpenCases: true,
      },
    });
  });

  it("reports PROVISIONING for an orphaned Resident and reconciles by starting the Workflow", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ residents: [] }));
    const { app, start } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { provisioningState: "PROVISIONING", canOpenCases: false },
    });
    expect(start).toHaveBeenCalledWith(
      "ResidentProvisioningWorkflow",
      expect.objectContaining({
        workflowId: `resident-provisioning/${residentId}`,
      })
    );
  });

  it("returns 503 when the Resident atom is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request("/api/me");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "RESIDENT_ATOM_UNAVAILABLE" },
    });
  });
});

describe("Auth proxy", () => {
  it("is reachable without Gateway authentication and passes the proxied response through unchanged", async () => {
    const upstreamBody = JSON.stringify({
      user: {
        id: residentId,
        name: "Rae Resident",
        email: "rae@example.com",
        role: "resident",
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { app, start } = createApp(undefined, fetchImpl, {
      authenticate: rejectingAuth,
    });

    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rae Resident",
        email: "rae@example.com",
        password: "hunter22",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    expect(start).toHaveBeenCalledWith(
      "ResidentProvisioningWorkflow",
      expect.objectContaining({
        args: [
          {
            accountId: residentId,
            fullName: "Rae Resident",
            email: "rae@example.com",
          },
        ],
      })
    );
    const startedArgs = start.mock.calls[0][1].args[0];
    expect(startedArgs).not.toHaveProperty("password");
    expect(startedArgs).not.toHaveProperty("token");
  });

  it("forwards a client-supplied role unchanged to the auth atom without granting Gateway privilege", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        user: {
          id: officerId,
          name: "Attempted Officer",
          email: "x@example.com",
          role: "RESIDENT",
        },
      })
    );
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: rejectingAuth,
    });
    const signupBody = {
      name: "Attempted Officer",
      email: "x@example.com",
      password: "hunter22",
      role: "OFFICER",
    };

    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signupBody),
    });

    // The Gateway forwards the body verbatim and never reads/enforces `role`
    // itself — it only reacts to the role the auth atom's response reports.
    // This proves the Gateway does not strip or grant privilege on this path;
    // it does NOT prove the auth atom rejects the role. That guarantee lives
    // in the auth atom's `input: false` field config (apps/atoms/auth/src/auth.ts)
    // and is exercised separately in the auth atom's own test suite.
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://auth-atom:5001/api/auth/sign-up/email",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(signupBody),
      })
    );
  });
});

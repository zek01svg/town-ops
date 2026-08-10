import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  fetchResolving,
  officerId,
  otherResidentId,
  rejectingAuth,
  residentAuth,
  residentId,
  successResult,
} from "./helpers";

const residentAbsentFetch = () =>
  fetchResolving(Response.json({ residents: [] }));

const residentFoundFetch = () =>
  vi.fn().mockResolvedValue(Response.json({ residents: [{ id: residentId }] }));

describe("Gateway Resident ownership and privilege boundaries", () => {
  const residentBody = {
    category: "LE",
    priority: "HIGH",
    description: "Broken street light",
    postalCode: "123456",
  };
  it("rejects a Resident-supplied residentId as a privilege-field injection", async () => {
    const { app, executeUpdateWithStart } = createApp(
      undefined,
      residentFoundFetch(),
      {
        authenticate: residentAuth,
      }
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
      {
        authenticate: residentAuth,
      }
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
      {
        authenticate: residentAuth,
      }
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
  it("forwards the browser Origin header to Better Auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({}));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: rejectingAuth,
    });

    const response = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3001",
      },
      body: JSON.stringify({
        email: "officer@townops.dev",
        password: "hunter22",
      }),
    });

    expect(response.status).toBe(200);
    const proxiedRequest = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(proxiedRequest?.headers).get("origin")).toBe(
      "http://localhost:3001"
    );
  });

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
    const startedArgs = start.mock.calls[0]?.[1]?.args?.[0];
    // Guards the two negative assertions below from passing vacuously.
    expect(startedArgs).toBeDefined();
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

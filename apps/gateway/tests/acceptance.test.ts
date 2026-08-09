import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  fetchResolving,
  successResult,
  workerServiceToken,
} from "./helpers";

describe("Gateway Contractor acceptance", () => {
  const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
  const contractorAuth: MiddlewareHandler = async (c, next) => {
    c.set("jwtPayload", {
      sub: "e5e5e5e5-5555-4555-8555-555555555555",
      role: "contractor",
      contractorId,
    });
    await next();
  };
  const assignment = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    caseId: successResult.data.id,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  const attempt = {
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    assignmentId: assignment.id,
    contractorId,
    source: "AUTO_ASSIGN" as const,
    status: "PENDING_ACCEPTANCE" as const,
    acceptanceSlaMs: 60_000,
    deadlineAt: "2026-07-22T00:01:00.000Z",
    actorId: "00000000-0000-0000-0000-000000000000",
    actorRole: "SYSTEM",
    reason: null,
    operationId: "allocate/1",
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  const accepted = {
    kind: "SUCCESS" as const,
    data: {
      assignment,
      attempt: { ...attempt, status: "ACCEPTED" as const },
      appointment: {
        id: "cccccccc-1111-4111-8111-111111111111",
        caseId: successResult.data.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        contractorId,
        startTime: "2030-01-01T09:00:00.000Z",
        endTime: "2030-01-01T10:00:00.000Z",
        status: "SCHEDULED" as const,
        reason: null,
        operationId: "accept/1/confirm",
        createdAt: "2030-01-01T00:00:00.000Z",
      },
    },
  };
  const assignmentFetch = fetchResolving(
    Response.json({ assignment, attempt })
  );

  it("allows a PUT preflight for the acceptance route", async () => {
    const { app } = createApp(undefined, assignmentFetch, {
      authenticate: contractorAuth,
    });
    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attempt.id}/acceptance`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3002",
          "Access-Control-Request-Method": "PUT",
        },
      }
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PUT"
    );
  });

  it("accepts only the Contractor named on the current Attempt through Temporal", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue(accepted);
    const fetchImpl = fetchResolving(Response.json({ assignment, attempt }));
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attempt.id}/acceptance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { appointment: { status: "SCHEDULED" } },
    });
    const [atomUrl, atomInit] = fetchImpl.mock.calls[0] ?? [];
    expect(atomUrl).toBe(
      `http://localhost:5004/api/assignments/by-case/${successResult.data.id}`
    );
    expect(new Headers(atomInit?.headers).get("Authorization")).toBe(
      `Bearer ${workerServiceToken}`
    );
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "acceptAllocation",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "CONTRACTOR",
            contractorId,
            assignmentId: assignment.id,
            attemptId: attempt.id,
          }),
        ],
      })
    );
  });

  it("returns a validation error when a past interval reaches the Workflow", async () => {
    const executeUpdateWithStart = vi
      .fn()
      .mockResolvedValue({ kind: "APPOINTMENT_NOT_FUTURE" });
    const fetchImpl = fetchResolving(Response.json({ assignment, attempt }));
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attempt.id}/acceptance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          startTime: "2020-01-01T09:00:00.000Z",
          endTime: "2020-01-01T10:00:00.000Z",
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "APPOINTMENT_NOT_FUTURE" },
    });
    expect(executeUpdateWithStart).toHaveBeenCalled();
  });

  it("allows a timed-out acceptance retry to reattach after its interval starts", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue(accepted);
    const fetchImpl = fetchResolving(Response.json({ assignment, attempt }));
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attempt.id}/acceptance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          startTime: new Date(Date.now() - 60_000).toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { appointment: { status: "SCHEDULED" } },
    });
  });

  it("does not reveal or submit another Contractor's Attempt", async () => {
    const executeUpdateWithStart = vi.fn();
    const fetchImpl = fetchResolving(
      Response.json({
        assignment,
        attempt: { ...attempt, contractorId: randomUUID() },
      })
    );
    const { app } = createApp(executeUpdateWithStart, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(
      `/api/cases/${successResult.data.id}/allocation-attempts/${attempt.id}/acceptance`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          startTime: "2030-01-01T09:00:00.000Z",
          endTime: "2030-01-01T10:00:00.000Z",
        }),
      }
    );

    expect(response.status).toBe(404);
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });
});

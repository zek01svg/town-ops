import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createApp, successResult, validBody } from "./helpers";

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

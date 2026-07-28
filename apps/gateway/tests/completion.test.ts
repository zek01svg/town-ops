import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createApp, successResult } from "./helpers";

const contractorId = "c1c1c1c1-1111-4111-8111-111111111111";
const assignmentId = "a1a1a1a1-1111-4111-8111-111111111111";
const attemptId = "b1b1b1b1-1111-4111-8111-111111111111";
const appointmentId = "d1d1d1d1-1111-4111-8111-111111111111";
const caseId = successResult.data.id;

function requestHref(url: RequestInfo | URL) {
  if (typeof url === "string") return url;
  return url instanceof URL ? url.href : url.url;
}

const contractorAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "e5e5e5e5-5555-4555-8555-555555555555",
    role: "contractor",
    contractorId,
  });
  await next();
};

const assignment = {
  id: assignmentId,
  caseId,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};
const attempt = {
  id: attemptId,
  assignmentId,
  contractorId,
  source: "AUTO_ASSIGN",
  status: "ACCEPTED",
  acceptanceSlaMs: 60_000,
  deadlineAt: "2030-01-01T00:01:00.000Z",
  actorId: "00000000-0000-0000-0000-000000000000",
  actorRole: "SYSTEM",
  reason: null,
  operationId: "allocate/1",
  createdAt: "2030-01-01T00:00:00.000Z",
};
const appointment = {
  id: appointmentId,
  caseId,
  assignmentId,
  attemptId,
  contractorId,
  startTime: "2030-01-01T09:00:00.000Z",
  endTime: "2030-01-01T10:00:00.000Z",
  status: "IN_PROGRESS",
  reason: null,
  operationId: "accept/1/confirm",
  createdAt: "2030-01-01T00:00:00.000Z",
};

const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const pngMagic = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const webpMagic = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function imageBlob(bytes = pngMagic, type = "image/png") {
  return new Blob([bytes], { type });
}

function proof(id: string, type: "BEFORE" | "AFTER") {
  return {
    id,
    caseId,
    contractorId,
    mediaUrl: `https://proof.example/${id}`,
    type,
    remarks: null,
    checksum: "a".repeat(64),
    ready: true,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function assignedFetch(
  proofResponse: Response,
  caseRecord = { ...successResult.data, status: "in_progress" },
  appointmentRecord = appointment
) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = requestHref(url);
    if (href.includes("/api/assignments/by-case/")) {
      return Response.json({ assignment, attempt });
    }
    if (href.includes("/api/cases/")) {
      return Response.json({ cases: [caseRecord] });
    }
    if (href.includes("/api/appointments/")) {
      return Response.json({ appointments: [appointmentRecord] });
    }
    return proofResponse;
  });
}

describe("Gateway completion boundary (PRS-147)", () => {
  it("rejects client-supplied ownership fields before reading server-side ownership", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });
    const form = new FormData();
    form.append("file", imageBlob(), "before.png");
    form.append("type", "BEFORE");
    form.append("contractorId", randomUUID());

    const response = await app.request(`/api/cases/${caseId}/proof-items`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("derives upload identity from the Contractor assignment and forwards no client ownership", async () => {
    const proofItemId = randomUUID();
    const fetchImpl = assignedFetch(
      Response.json({ proof: proof(proofItemId, "BEFORE") })
    );
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });
    const form = new FormData();
    form.append("file", imageBlob(), "before.png");
    form.append("type", "BEFORE");

    const response = await app.request(`/api/cases/${caseId}/proof-items`, {
      method: "POST",
      headers: { "Idempotency-Key": proofItemId },
      body: form,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { id: proofItemId, contractorId },
      operation: { caseId, idempotencyKey: proofItemId },
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "http://localhost:5007/internal/proof-items",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": proofItemId,
        }),
      })
    );
  });

  it("keeps the Contractor proof list usable without requiring an in-progress Case", async () => {
    const beforeId = randomUUID();
    const fetchImpl = assignedFetch(
      Response.json({ proof: [proof(beforeId, "BEFORE")] }),
      {
        ...successResult.data,
        status: "completed",
      }
    );
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });

    const response = await app.request(`/api/cases/${caseId}/proof-items`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [expect.objectContaining({ id: beforeId, type: "BEFORE" })],
    });
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        requestHref(url).includes("/api/cases/")
      )
    ).toBe(false);
  });

  it.each([
    [
      "completed Case",
      { ...successResult.data, status: "completed" },
      appointment,
    ],
    [
      "non-in-progress Appointment",
      { ...successResult.data, status: "in_progress" },
      { ...appointment, status: "SCHEDULED" },
    ],
  ])(
    "rejects proof upload for a %s before calling Proof Atom",
    async (_name, caseRecord, appointmentRecord) => {
      const fetchImpl = assignedFetch(
        Response.json({ proof: proof(randomUUID(), "BEFORE") }),
        caseRecord,
        appointmentRecord
      );
      const { app } = createApp(undefined, fetchImpl, {
        authenticate: contractorAuth,
      });
      const form = new FormData();
      form.append("file", imageBlob(), "before.png");
      form.append("type", "BEFORE");

      const response = await app.request(`/api/cases/${caseId}/proof-items`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: form,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "NOT_IN_PROGRESS", retryable: false },
      });
      expect(
        fetchImpl.mock.calls.some(([url]) =>
          requestHref(url).endsWith("/internal/proof-items")
        )
      ).toBe(false);
    }
  );

  it("starts completion with server-derived Appointment and Assignment IDs", async () => {
    const beforeId = randomUUID();
    const afterId = randomUUID();
    const completedAppointment = { ...appointment, status: "COMPLETED" };
    const completedCase = {
      ...successResult.data,
      status: "COMPLETED" as const,
    };
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "SUCCESS",
      data: {
        appointment: completedAppointment,
        assignment,
        case: completedCase,
      },
    });
    const { app } = createApp(
      executeUpdateWithStart,
      assignedFetch(Response.json({ proof: [] })),
      {
        authenticate: contractorAuth,
      }
    );
    const idempotencyKey = randomUUID();

    const response = await app.request(`/api/cases/${caseId}/completion`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        report: "  Work completed.  ",
        proofItemIds: [afterId, beforeId],
      }),
    });

    expect(response.status).toBe(200);
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "completeCase",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actorRole: "CONTRACTOR",
            contractorId,
            caseId,
            assignmentId,
            appointmentId,
            input: {
              report: "Work completed.",
              proofItemIds: [afterId, beforeId].toSorted(),
            },
          }),
        ],
      })
    );
  });

  it("normalizes report whitespace and duplicate proof IDs before the Workflow receives completion", async () => {
    const beforeId = "11111111-1111-4111-8111-111111111111";
    const afterId = "22222222-2222-4222-8222-222222222222";
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "NOT_IN_PROGRESS",
    });
    const { app } = createApp(
      executeUpdateWithStart,
      assignedFetch(Response.json({ proof: [] })),
      {
        authenticate: contractorAuth,
      }
    );

    const response = await app.request(`/api/cases/${caseId}/completion`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        report: "  Work completed.  ",
        proofItemIds: [afterId, beforeId, afterId],
      }),
    });

    expect(response.status).toBe(409);
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "completeCase",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            input: {
              report: "Work completed.",
              proofItemIds: [beforeId, afterId],
            },
          }),
        ],
      })
    );
  });

  it("keeps the domain completion operation stable while using a fresh Temporal delivery ID per retry", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "SUCCESS",
      data: {
        appointment: { ...appointment, status: "COMPLETED" },
        assignment,
        case: { ...successResult.data, status: "COMPLETED" },
      },
    });
    const { app } = createApp(
      executeUpdateWithStart,
      assignedFetch(Response.json({ proof: [] })),
      {
        authenticate: contractorAuth,
      }
    );
    const idempotencyKey = randomUUID();
    const body = JSON.stringify({
      report: "Work completed.",
      proofItemIds: [randomUUID(), randomUUID()],
    });
    const request = () =>
      app.request(`/api/cases/${caseId}/completion`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    const first = executeUpdateWithStart.mock.calls[0]?.[1];
    const second = executeUpdateWithStart.mock.calls[1]?.[1];
    const firstCommand = first?.args?.[0];
    const secondCommand = second?.args?.[0];

    expect(secondCommand).toMatchObject({
      idempotencyKey: firstCommand?.idempotencyKey,
      payloadHash: firstCommand?.payloadHash,
      operationId: firstCommand?.operationId,
      input: firstCommand?.input,
    });
    expect(first?.updateId).not.toBe(second?.updateId);
    expect(
      first?.updateId.startsWith(`${firstCommand?.operationId}/delivery/`)
    ).toBe(true);
    expect(
      second?.updateId.startsWith(`${secondCommand?.operationId}/delivery/`)
    ).toBe(true);
  });

  it.each([
    ["JPEG", "image/jpeg", jpegMagic, "proof.jpg"],
    ["PNG", "image/png", pngMagic, "proof.png"],
    ["WebP", "image/webp", webpMagic, "proof.webp"],
  ])(
    "forwards a supported %s Proof upload",
    async (_name, mime, bytes, name) => {
      const proofItemId = randomUUID();
      const fetchImpl = assignedFetch(
        Response.json({ proof: proof(proofItemId, "BEFORE") })
      );
      const { app } = createApp(undefined, fetchImpl, {
        authenticate: contractorAuth,
      });
      const form = new FormData();
      form.append("file", imageBlob(bytes, mime), name);
      form.append("type", "BEFORE");

      const response = await app.request(`/api/cases/${caseId}/proof-items`, {
        method: "POST",
        headers: { "Idempotency-Key": proofItemId },
        body: form,
      });

      expect(response.status).toBe(201);
      expect(
        fetchImpl.mock.calls.some(([url]) =>
          requestHref(url).endsWith("/internal/proof-items")
        )
      ).toBe(true);
    }
  );

  it.each([
    ["an unsupported MIME type", "image/gif", pngMagic, "proof.gif"],
    ["a PNG MIME type with JPEG bytes", "image/png", jpegMagic, "proof.png"],
  ])(
    "rejects %s before reading Case ownership or forwarding",
    async (_name, mime, bytes, name) => {
      const fetchImpl = vi.fn();
      const { app } = createApp(undefined, fetchImpl, {
        authenticate: contractorAuth,
      });
      const form = new FormData();
      form.append("file", imageBlob(bytes, mime), name);
      form.append("type", "BEFORE");

      const response = await app.request(`/api/cases/${caseId}/proof-items`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: form,
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        error: { code: "UNSUPPORTED_PROOF_IMAGE", retryable: false },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("rejects an oversized multipart body from Content-Length before forwarding", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: contractorAuth,
    });
    const form = new FormData();
    form.append("file", imageBlob(), "proof.png");
    form.append("type", "BEFORE");

    const response = await app.request(`/api/cases/${caseId}/proof-items`, {
      method: "POST",
      headers: {
        "Content-Length": String(10 * 1024 * 1024 + 64 * 1024 + 1),
        "Idempotency-Key": randomUUID(),
      },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PROOF_FILE_TOO_LARGE", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

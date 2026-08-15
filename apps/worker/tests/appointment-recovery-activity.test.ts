import { randomUUID } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import type {
  MarkCaseAppointmentReplacedInput,
  MarkAppointmentMissedInput,
  MarkCaseNoAccessInput,
  ReplaceAppointmentSlotInput,
  ReportNoAccessAppointmentInput,
} from "@townops/orchestration-contract";
import { describe, expect, it, vi } from "vitest";

import { createAppointmentRecoveryActivities } from "../src/activities/appointment-recovery";

const workerServiceToken = "a".repeat(32);

function dependencies(
  fetchImpl: typeof fetch,
  mintIdentityToken?: (audience: string) => Promise<string | undefined>
) {
  return createAppointmentRecoveryActivities({
    appointmentAtomUrl: "http://appointment-atom:5003",
    caseAtomUrl: "http://case-atom:5005",
    workerServiceToken,
    fetchImpl,
    mintIdentityToken,
  });
}

/** The shape the Appointment atom's routes actually answer with. */
function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    caseId: randomUUID(),
    assignmentId: randomUUID(),
    attemptId: randomUUID(),
    contractorId: randomUUID(),
    startTime: "2030-01-01T09:00:00.000Z",
    endTime: "2030-01-01T10:00:00.000Z",
    status: "NO_ACCESS",
    reason: null,
    operationId: `${randomUUID()}/appointment`,
    createdAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The Case atom answers with its raw row: lowercase enums, no re-casing. */
function caseRow(caseId: string, status: string) {
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "le",
    priority: "high",
    status,
    description: "Broken street light",
    addressDetails: null,
    postalCode: "123456",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("appointment-recovery activities identity header (PRS-140 Phase 5)", () => {
  it("attaches X-Serverless-Authorization alongside Authorization when a minter is injected", async () => {
    const input: ReportNoAccessAppointmentInput = {
      operationId: `${randomUUID()}/no-access/appointment`,
      appointmentId: randomUUID(),
      contractorId: randomUUID(),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "NO_ACCESS",
          appointment: appointmentRow({
            id: input.appointmentId,
            contractorId: input.contractorId,
            operationId: input.operationId,
          }),
        },
        { status: 201 }
      )
    );
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");

    await dependencies(fetchImpl, mintIdentityToken).reportNoAccessAppointment(
      input
    );

    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith(
      "http://appointment-atom:5003"
    );
  });
});

describe("reportNoAccessAppointment activity", () => {
  const input: ReportNoAccessAppointmentInput = {
    operationId: `${randomUUID()}/no-access/appointment`,
    appointmentId: randomUUID(),
    contractorId: randomUUID(),
  };

  it("parses a 201 NO_ACCESS response and posts to the appointment atom", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "NO_ACCESS",
          appointment: appointmentRow({
            id: input.appointmentId,
            contractorId: input.contractorId,
            operationId: input.operationId,
          }),
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).reportNoAccessAppointment(input)
    ).resolves.toMatchObject({
      outcome: "NO_ACCESS",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://appointment-atom:5003/internal/appointment-slots/no-access",
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

  it("parses a 409 NOT_SCHEDULED domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "NOT_SCHEDULED" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).reportNoAccessAppointment(input)
    ).resolves.toEqual({
      outcome: "NOT_SCHEDULED",
    });
  });

  it("parses a 404 APPOINTMENT_NOT_FOUND domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "APPOINTMENT_NOT_FOUND" }, { status: 404 })
      );

    await expect(
      dependencies(fetchImpl).reportNoAccessAppointment(input)
    ).resolves.toEqual({
      outcome: "APPOINTMENT_NOT_FOUND",
    });
  });

  it("throws a non-retryable ApplicationFailure on an unrecognized 4xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "bad request" }, { status: 400 })
      );

    const failure = await dependencies(fetchImpl)
      .reportNoAccessAppointment(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure)) {
      throw new Error("expected an ApplicationFailure");
    }
    expect(failure.nonRetryable).toBe(true);
    expect(failure.type).toBe("APPOINTMENT_NO_ACCESS_REJECTED");
  });

  it("throws a retryable error on a 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }));

    await expect(
      dependencies(fetchImpl).reportNoAccessAppointment(input)
    ).rejects.toThrow(/failed with 503/);
  });
});

describe("markAppointmentMissed activity", () => {
  const input: MarkAppointmentMissedInput = {
    operationId: `${randomUUID()}/missed-appointment/${randomUUID()}`,
    appointmentId: randomUUID(),
  };

  it("parses a 201 MISSED response and posts to the appointment atom", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "MISSED",
          appointment: appointmentRow({
            id: input.appointmentId,
            status: "MISSED",
            operationId: input.operationId,
          }),
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).markAppointmentMissed(input)
    ).resolves.toMatchObject({
      outcome: "MISSED",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://appointment-atom:5003/internal/appointment-slots/missed",
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

  it("parses every known expiry outcome rather than throwing", async () => {
    for (const [body, status] of [
      [
        {
          outcome: "ALREADY_MISSED",
          appointment: appointmentRow({ status: "MISSED" }),
        },
        201,
      ],
      [{ outcome: "NOT_SCHEDULED" }, 409],
      [{ outcome: "APPOINTMENT_NOT_FOUND" }, 404],
    ] as const) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json(body, { status }));
      await expect(
        dependencies(fetchImpl).markAppointmentMissed(input)
      ).resolves.toMatchObject(body);
    }
  });

  it("classifies an unexpected 4xx as non-retryable and a 5xx as retryable", async () => {
    const rejected = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "bad" }, { status: 400 }));
    const failure = await dependencies(rejected)
      .markAppointmentMissed(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure))
      throw new Error("unreachable");
    expect(failure.type).toBe("APPOINTMENT_MISSED_REJECTED");

    const failed = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }));
    await expect(
      dependencies(failed).markAppointmentMissed(input)
    ).rejects.toThrow(/failed with 503/);
  });
});

describe("markCaseNoAccess activity", () => {
  const input: MarkCaseNoAccessInput = {
    caseId: randomUUID(),
    operationId: `${randomUUID()}/case`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
  };

  it("uppercases the atom's lowercase category/priority/status", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "PENDING_RESIDENT_INPUT",
          case: caseRow(input.caseId, "pending_resident_input"),
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).markCaseNoAccess(input)
    ).resolves.toMatchObject({
      outcome: "PENDING_RESIDENT_INPUT",
      case: {
        category: "LE",
        priority: "HIGH",
        status: "PENDING_RESIDENT_INPUT",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://case-atom:5005/internal/cases/${input.caseId}/no-access`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("parses a 409 CASE_TERMINAL domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "CASE_TERMINAL" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).markCaseNoAccess(input)
    ).resolves.toEqual({
      outcome: "CASE_TERMINAL",
    });
  });

  it("throws a non-retryable ApplicationFailure on an unrecognized 4xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "bad request" }, { status: 400 })
      );

    const failure = await dependencies(fetchImpl)
      .markCaseNoAccess(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure)) {
      throw new Error("expected an ApplicationFailure");
    }
    expect(failure.nonRetryable).toBe(true);
  });

  it("throws a retryable error on a 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 502 }));

    await expect(
      dependencies(fetchImpl).markCaseNoAccess(input)
    ).rejects.toThrow(/failed with 502/);
  });
});

describe("replaceAppointmentSlot activity", () => {
  const input: ReplaceAppointmentSlotInput = {
    operationId: `${randomUUID()}/replace`,
    caseId: randomUUID(),
    appointmentId: randomUUID(),
    startTime: "2030-02-01T09:00:00.000Z",
    endTime: "2030-02-01T10:00:00.000Z",
  };

  it("parses a 201 REPLACED response and posts to the appointment atom", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "REPLACED",
          appointment: appointmentRow({
            caseId: input.caseId,
            status: "SCHEDULED",
          }),
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).replaceAppointmentSlot(input)
    ).resolves.toMatchObject({
      outcome: "REPLACED",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://appointment-atom:5003/internal/appointment-slots/replacements",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  });

  it("parses a 409 CONFLICT domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "CONFLICT" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).replaceAppointmentSlot(input)
    ).resolves.toEqual({
      outcome: "CONFLICT",
    });
  });

  it("parses a 404 APPOINTMENT_NOT_FOUND domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "APPOINTMENT_NOT_FOUND" }, { status: 404 })
      );

    await expect(
      dependencies(fetchImpl).replaceAppointmentSlot(input)
    ).resolves.toEqual({
      outcome: "APPOINTMENT_NOT_FOUND",
    });
  });

  it("throws a non-retryable ApplicationFailure on an unrecognized 4xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "bad request" }, { status: 422 })
      );

    const failure = await dependencies(fetchImpl)
      .replaceAppointmentSlot(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure)) {
      throw new Error("expected an ApplicationFailure");
    }
    expect(failure.nonRetryable).toBe(true);
    expect(failure.type).toBe("APPOINTMENT_REPLACEMENT_REJECTED");
  });

  it("throws a retryable error on a 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    await expect(
      dependencies(fetchImpl).replaceAppointmentSlot(input)
    ).rejects.toThrow(/failed with 500/);
  });
});

describe("markCaseAppointmentReplaced activity", () => {
  const input: MarkCaseAppointmentReplacedInput = {
    caseId: randomUUID(),
    operationId: `${randomUUID()}/case`,
    actorId: randomUUID(),
    actorRole: "RESIDENT",
  };

  it("uppercases the atom's lowercase category/priority/status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { outcome: "REPLACED", case: caseRow(input.caseId, "assigned") },
          { status: 201 }
        )
      );

    await expect(
      dependencies(fetchImpl).markCaseAppointmentReplaced(input)
    ).resolves.toMatchObject({
      outcome: "REPLACED",
      case: { category: "LE", priority: "HIGH", status: "ASSIGNED" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://case-atom:5005/internal/cases/${input.caseId}/appointment-replaced`,
      expect.objectContaining({ method: "POST" })
    );
  });

  // AC7 recovery: a Case parked on the Resident comes back as assigned. The
  // conditional itself lives in the Case atom; this only proves the Activity
  // passes an untouched pending_resident_input row through unbroken.
  it("re-cases a pending_resident_input row the same way", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      Response.json(
        {
          outcome: "REPLACED",
          case: caseRow(input.caseId, "pending_resident_input"),
        },
        { status: 201 }
      )
    );

    await expect(
      dependencies(fetchImpl).markCaseAppointmentReplaced(input)
    ).resolves.toMatchObject({
      outcome: "REPLACED",
      case: { status: "PENDING_RESIDENT_INPUT" },
    });
  });

  it("parses a 409 CASE_TERMINAL domain outcome rather than throwing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ outcome: "CASE_TERMINAL" }, { status: 409 })
      );

    await expect(
      dependencies(fetchImpl).markCaseAppointmentReplaced(input)
    ).resolves.toEqual({
      outcome: "CASE_TERMINAL",
    });
  });

  it("throws a non-retryable ApplicationFailure on an unrecognized 4xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "bad request" }, { status: 403 })
      );

    const failure = await dependencies(fetchImpl)
      .markCaseAppointmentReplaced(input)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    if (!(failure instanceof ApplicationFailure)) {
      throw new Error("expected an ApplicationFailure");
    }
    expect(failure.nonRetryable).toBe(true);
  });

  it("throws a retryable error on a 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }));

    await expect(
      dependencies(fetchImpl).markCaseAppointmentReplaced(input)
    ).rejects.toThrow(/failed with 503/);
  });
});

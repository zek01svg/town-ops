import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  officerAuth,
  officerId,
  otherResidentId,
  residentAuth,
  residentId,
  successResult,
} from "./helpers";

const caseId = successResult.data.id;
const cancellation = { reason: "Resident withdrew the request" };

type CaseRecord = Omit<typeof successResult.data, "status"> & {
  status: string;
};

function caseFetch(record: CaseRecord = successResult.data): typeof fetch {
  return vi.fn(async () => Response.json({ cases: [record] }));
}

function request() {
  return {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(cancellation),
  };
}

describe("Gateway Case cancellation (PRS-148)", () => {
  it("lets an Officer cancel an eligible Case through the workflow", async () => {
    const executeUpdateWithStart = vi.fn().mockResolvedValue({
      kind: "SUCCESS",
      data: { case: { ...successResult.data, status: "CANCELLED" } },
    });
    const { app } = createApp(executeUpdateWithStart, caseFetch(), {
      authenticate: officerAuth,
    });

    const response = await app.request(
      `/api/cases/${caseId}/cancel`,
      request()
    );

    expect(response.status).toBe(200);
    expect(executeUpdateWithStart).toHaveBeenCalledWith(
      "cancelCase",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            caseId,
            actorId: officerId,
            actorRole: "OFFICER",
            input: cancellation,
          }),
        ],
      })
    );
  });

  it("conceals another Resident's Case without reaching Temporal", async () => {
    const executeUpdateWithStart = vi.fn();
    const { app } = createApp(
      executeUpdateWithStart,
      caseFetch({ ...successResult.data, residentId: otherResidentId }),
      { authenticate: residentAuth }
    );

    const response = await app.request(
      `/api/cases/${caseId}/cancel`,
      request()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_NOT_FOUND", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
  });

  it("rejects a terminal or in-progress Case before reaching Temporal", async () => {
    const executeUpdateWithStart = vi.fn();
    const { app } = createApp(
      executeUpdateWithStart,
      caseFetch({ ...successResult.data, status: "IN_PROGRESS" }),
      { authenticate: residentAuth }
    );

    const response = await app.request(
      `/api/cases/${caseId}/cancel`,
      request()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_CANCELLABLE", retryable: false },
    });
    expect(executeUpdateWithStart).not.toHaveBeenCalled();
    expect(residentId).toBe(successResult.data.residentId);
  });
});

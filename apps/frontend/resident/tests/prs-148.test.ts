// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { isResidentCaseCancellable } from "../src/features/case/components/resident-case-desk";
import { cancelCase, getCase } from "../src/libr/gateway";

afterEach(() => vi.restoreAllMocks());

test("cancels only through the Gateway and retains the supplied idempotency key", async () => {
  const caseId = "22222222-2222-4222-8222-222222222222";
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        case: {
          id: caseId,
          residentId: "33333333-3333-4333-8333-333333333333",
          category: "LE",
          priority: "HIGH",
          status: "CANCELLED",
          description: "Broken street light",
          addressDetails: null,
          postalCode: "123456",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      },
    })
  );

  await cancelCase(caseId, { reason: "No longer needed" }, idempotencyKey);

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining(`/api/cases/${caseId}/cancel`),
    expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ "Idempotency-Key": idempotencyKey }),
    })
  );
});

test("loads an existing eligible Case through the owner-protected Gateway read for cancellation", async () => {
  const caseId = "22222222-2222-4222-8222-222222222222";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        id: caseId,
        residentId: "33333333-3333-4333-8333-333333333333",
        category: "LE",
        priority: "HIGH",
        status: "ASSIGNED",
        description: "Broken street light",
        addressDetails: null,
        postalCode: "123456",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        appointment: null,
      },
    })
  );

  const existingCase = await getCase(caseId);

  expect(existingCase.id).toBe(caseId);
  expect(isResidentCaseCancellable(existingCase.status)).toBe(true);
});

test("returns the concealed non-owner or unknown Case error safely", async () => {
  const caseId = "22222222-2222-4222-8222-222222222222";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: { code: "CASE_NOT_FOUND", message: "Case was not found" } },
      { status: 404 }
    )
  );

  await expect(getCase(caseId)).rejects.toMatchObject({
    message: "Case was not found",
    code: "CASE_NOT_FOUND",
  });
});

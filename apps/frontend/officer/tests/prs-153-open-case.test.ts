// @vitest-environment jsdom

import { OpenCaseInputSchema } from "@townops/orchestration-contract";
import { expect, test, vi } from "vitest";

// Spec (PRS-153, 17A): Case opening moved off the open-case Composite onto
// the Gateway's `POST /api/cases`. These cover the two ways that migration
// can silently break — a body the Gateway rejects, and a form key set that
// drifts from the `.strict()` contract schema.

type OpenCasePayload = {
  residentId: string;
  category: string;
  priority: string;
  description: string;
  addressDetails: string;
  postalCode: string;
};

type MutationConfig = {
  mutationFn: (input: OpenCasePayload) => Promise<unknown>;
};

const { useMutation, gatewayFetch } = vi.hoisted(() => ({
  useMutation: vi.fn((config: MutationConfig) => config),
  gatewayFetch: vi.fn(
    (_url: string, _init: RequestInit, _authUrl: string): Promise<unknown> =>
      Promise.resolve({ data: {} })
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@townops/ui/libr/gateway", () => ({ gatewayFetch }));

const { useOpenCaseMutation } =
  await import("../src/features/case/api/mutations");
const { NEW_CASE_DEFAULTS } =
  await import("../src/features/case/components/new-case-form");

const validInput: OpenCasePayload = {
  residentId: "123e4567-e89b-12d3-a456-426614174000",
  category: "PL",
  priority: "HIGH",
  description: "Burst pipe under the sink",
  addressDetails: "BLK 201 ANG MO KIO AVENUE 3, Singapore 560201",
  postalCode: "560201",
};

/**
 * The Gateway hard-rejects a non-UUID `Idempotency-Key` with a 400 before it
 * reads the body (`apps/gateway/src/app.ts`), so a missing or malformed key
 * fails every Case opening rather than degrading.
 */
test("opens a Case through the Gateway with a camelCase body and a UUID Idempotency-Key", async () => {
  useMutation.mockClear();
  gatewayFetch.mockClear();

  // `useMutation` is mocked to return its config verbatim, so reading it back
  // off the mock gives the real `mutationFn` without asserting on the hook's
  // declared `UseMutationResult` return type.
  useOpenCaseMutation();
  const config = useMutation.mock.calls[0]?.[0];
  await config?.mutationFn(validInput);

  expect(gatewayFetch).toHaveBeenCalledTimes(1);
  const call = gatewayFetch.mock.calls[0];
  const url = call?.[0];
  const init = call?.[1];

  expect(url).toBe("http://localhost:6010/api/cases");
  expect(init?.method).toBe("POST");

  const headers = new Headers(init?.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("Idempotency-Key")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );

  // The body must be exactly what the contract accepts — the old Composite
  // took snake_case, so a half-finished rename would post `resident_id` here
  // and the Gateway's `.strict()` parse would 400.
  const body = typeof init?.body === "string" ? init.body : "";
  expect(JSON.parse(body)).toEqual(validInput);
});

test("the Gateway contract accepts the payload the form sends", () => {
  expect(OpenCaseInputSchema.safeParse(validInput).success).toBe(true);
});

/**
 * `OpenCaseInputSchema` is `.strict()` and `NewCaseForm`'s `onSubmit` bails
 * on a parse failure without surfacing anything, so drift between these two
 * key sets makes the submit button do nothing at all. This is the guard for
 * that: it fails on a renamed key, an added key, or a dropped one.
 */
test("the form's field names match the contract exactly", () => {
  expect(Object.keys(NEW_CASE_DEFAULTS).toSorted()).toEqual(
    Object.keys(OpenCaseInputSchema.shape).toSorted()
  );
});

test("rejects the Composite's old snake_case shape", () => {
  const legacy = {
    resident_id: validInput.residentId,
    category: validInput.category,
    priority: "high",
    description: validInput.description,
    address_details: validInput.addressDetails,
    postal_code: validInput.postalCode,
  };

  expect(OpenCaseInputSchema.safeParse(legacy).success).toBe(false);
});

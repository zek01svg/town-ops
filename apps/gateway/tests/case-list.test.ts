import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  officerAuth,
  otherResidentId,
  residentAuth,
  residentId,
  successResult,
  throwingUnauthorizedAuth,
  validBody,
} from "./helpers";
import { recoveryContractorAuth } from "./recovery-helpers";

/**
 * A `fetch` mock call carries `RequestInfo | URL`, and a bare `String()` on the
 * `Request` arm of that union stringifies to "[object Object]" — an assertion
 * against it would silently pass on any URL. Narrow first.
 */
function hrefOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

const caseIdA = "aaaaaaaa-1111-4111-8111-111111111111";
const caseIdB = "bbbbbbbb-1111-4111-8111-111111111111";
const assignmentIdA = "cccccccc-1111-4111-8111-111111111111";
const assignmentIdB = "dddddddd-1111-4111-8111-111111111111";

/** A CONTRACTOR token missing the `contractorId` claim altogether. */
const contractorNoIdAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "e5e5e5e5-5555-4555-8555-555555555555",
    role: "contractor",
  });
  await next();
};
/** A CONTRACTOR token whose `contractorId` claim doesn't parse as a UUID. */
const contractorInvalidIdAuth: MiddlewareHandler = async (c, next) => {
  c.set("jwtPayload", {
    sub: "e5e5e5e5-5555-4555-8555-555555555555",
    role: "contractor",
    contractorId: "not-a-uuid",
  });
  await next();
};

const baseCaseRecord = {
  id: caseIdA,
  residentId,
  category: "LE",
  priority: "HIGH",
  description: "Broken street light",
  addressDetails: null,
  postalCode: "123456",
  status: "pending",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
};

/** Dispatches by atom, the same way `recoveryFetch` does for the other read
 * routes — here only the Case atom's `/api/cases` and the assignment atom's
 * Contractor Case scope route are ever hit. */
function caseListFetch(options: {
  cases?: unknown[];
  scope?: { items: unknown[]; page: number; pageSize: number };
}) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const href = hrefOf(url);
    if (href.includes("/api/assignments/contractor/")) {
      return Response.json(
        options.scope ?? { items: [], page: 1, pageSize: 25 }
      );
    }
    return Response.json({ cases: options.cases ?? [] });
  });
}

describe("GET /api/cases (PRS-151)", () => {
  it("scopes a Resident's list to their own account id, even when the atom hands back a foreign Case too", async () => {
    const foreignCaseId = "12121212-1111-4111-8111-111111111111";
    // The Gateway must not simply trust the atom's `?residentId=` filter —
    // it re-verifies ownership itself (mirrors the CONTRACTOR branch and the
    // Case detail route). A stub that only ever returns matching rows can't
    // distinguish "the Gateway filtered" from "the mock already agreed", so
    // this one hands back a foreign row on purpose.
    const fetchImpl = caseListFetch({
      cases: [
        baseCaseRecord,
        { ...baseCaseRecord, id: foreignCaseId, residentId: otherResidentId },
      ],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: residentAuth,
    });

    const response = await app.request("/api/cases");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(caseIdA);
    expect(JSON.stringify(body)).not.toContain(foreignCaseId);
    expect(JSON.stringify(body)).not.toContain(otherResidentId);
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(hrefOf(calledUrl)).toContain(`residentId=${residentId}`);
  });

  it("scopes a Contractor's list to the assignment atom's scope, projects each row by its own participation on a mixed page, and forwards the scope page's pageSize to the ids fan-in", async () => {
    const scope = {
      items: [
        {
          caseId: caseIdA,
          assignmentId: assignmentIdA,
          participation: "CURRENT",
        },
        {
          caseId: caseIdB,
          assignmentId: assignmentIdB,
          // Mixed CURRENT + HISTORICAL on one page is the normal shape (a
          // Contractor with one live job and one they were replaced on) —
          // the projection is decided per row inside the `flatMap`, not
          // once for the whole page, and an all-CURRENT or all-HISTORICAL
          // fixture can't tell those two implementations apart.
          participation: "HISTORICAL",
        },
      ],
      page: 1,
      pageSize: 2,
    };
    const fetchImpl = caseListFetch({
      cases: [
        { ...baseCaseRecord, id: caseIdA },
        { ...baseCaseRecord, id: caseIdB },
      ],
      scope,
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases?pageSize=2");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(2);
    // CURRENT keeps the full CaseDto, postalCode included.
    expect(body.data.items[0].postalCode).toBe(baseCaseRecord.postalCode);
    // HISTORICAL, on the same page, is narrowed.
    expect(body.data.items[1]).not.toHaveProperty("postalCode");
    expect(body.data.items[1]).not.toHaveProperty("residentId");
    expect(body.data.items[1]).not.toHaveProperty("addressDetails");
    expect(body.data.items[1].postalSector).toBe(
      baseCaseRecord.postalCode.slice(0, 2)
    );
    const [scopeUrl, idsUrl] = fetchImpl.mock.calls.map(
      ([url]) => new URL(hrefOf(url))
    );

    // The truncation guard: the case atom's `?ids=` call still applies
    // `.limit(pageSize)` even though it skips the offset, so a smaller
    // pageSize than the scope call's would silently drop scoped Cases.
    expect(scopeUrl.searchParams.get("pageSize")).toBe("2");
    expect(idsUrl.searchParams.get("pageSize")).toBe(
      scopeUrl.searchParams.get("pageSize")
    );
  });

  it("excludes an un-scoped Case even if the Case atom's ?ids= response includes one", async () => {
    const unscopedCaseId = "ffffffff-1111-4111-8111-111111111111";
    const scope = {
      items: [
        {
          caseId: caseIdA,
          assignmentId: assignmentIdA,
          participation: "CURRENT",
        },
      ],
      page: 1,
      pageSize: 25,
    };
    // A defensive stand-in for an atom bug or a stale/looser `?ids=` filter:
    // the Case atom hands back one row the Contractor is not scoped to.
    const fetchImpl = caseListFetch({
      cases: [
        { ...baseCaseRecord, id: caseIdA },
        { ...baseCaseRecord, id: unscopedCaseId },
      ],
      scope,
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(caseIdA);
  });

  it.each([
    ["missing contractorId claim", contractorNoIdAuth],
    ["non-UUID contractorId claim", contractorInvalidIdAuth],
  ])(
    "rejects a Contractor with a %s with 403 FORBIDDEN, without calling any atom",
    async (_label, authenticate) => {
      const fetchImpl = vi.fn();
      const { app } = createApp(undefined, fetchImpl, { authenticate });

      const response = await app.request("/api/cases");

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "FORBIDDEN", retryable: false },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("returns an empty page without calling the Case atom when the Contractor has no scoped Cases", async () => {
    const fetchImpl = caseListFetch({
      scope: { items: [], page: 1, pageSize: 25 },
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ items: [], page: 1, pageSize: 25 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a pageSize over 100 without calling any atom", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases?pageSize=101");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults the Officer's page size to 25 and forwards it to the Case atom", async () => {
    const fetchImpl = caseListFetch({ cases: [baseCaseRecord] });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.pageSize).toBe(25);
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(new URL(hrefOf(calledUrl)).searchParams.get("pageSize")).toBe("25");
  });

  it("narrows a historical Contractor's Case to omit Resident identity, the full address, and the full postal code", async () => {
    const secretResidentId = "eeeeeeee-1111-4111-8111-111111111111";
    const secretAddress = "Unit 12-34, Blk 5";
    const fullPostalCode = "654321";
    const scope = {
      items: [
        {
          caseId: caseIdA,
          assignmentId: assignmentIdA,
          participation: "HISTORICAL",
        },
      ],
      page: 1,
      pageSize: 25,
    };
    const fetchImpl = caseListFetch({
      cases: [
        {
          ...baseCaseRecord,
          id: caseIdA,
          residentId: secretResidentId,
          addressDetails: secretAddress,
          postalCode: fullPostalCode,
        },
      ],
      scope,
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).not.toHaveProperty("residentId");
    expect(body.data.items[0]).not.toHaveProperty("addressDetails");
    expect(body.data.items[0]).not.toHaveProperty("postalCode");
    expect(body.data.items[0].postalSector).toBe(fullPostalCode.slice(0, 2));
    expect(JSON.stringify(body)).not.toContain(secretResidentId);
    expect(JSON.stringify(body)).not.toContain(secretAddress);
    expect(JSON.stringify(body)).not.toContain(fullPostalCode);
  });

  it("returns 503 CASE_ATOM_UNAVAILABLE rather than an empty list when the Case atom is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns 503 ASSIGNMENT_ATOM_UNAVAILABLE, not an empty list, when the assignment atom is unreachable for a Contractor", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns the common JSON error envelope, not Hono's plaintext 500, when a Case row fails to parse", async () => {
    // "dispatched" is a legacy DB status value CaseStatusSchema does not
    // carry (locked decision: the contract stays at 6 values) — toCaseDto's
    // `.parse()` throws, and this proves app.onError() catches it (AC1).
    const fetchImpl = caseListFetch({
      cases: [{ ...baseCaseRecord, status: "dispatched" }],
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR", retryable: false },
    });
  });

  it("forwards an Officer's status filter to the Case atom lowercased", async () => {
    const fetchImpl = caseListFetch({ cases: [baseCaseRecord] });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases?status=PENDING");

    expect(response.status).toBe(200);
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(new URL(hrefOf(calledUrl)).searchParams.get("status")).toBe(
      "pending"
    );
  });

  it("rejects a lowercase/unknown status from the client with a clean 400 VALIDATION_ERROR", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    // The contract's CaseStatusSchema is uppercase-only (6 values) — a
    // lowercase value the atom itself would accept must still fail at the
    // Gateway boundary, before ever reaching the Case atom.
    const response = await app.request("/api/cases?status=pending");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 503 CASE_ATOM_UNAVAILABLE, not an empty list, when the Case atom answers non-ok", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns 503 ASSIGNMENT_ATOM_UNAVAILABLE, not an empty list, when the assignment atom's scope call answers non-ok", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ASSIGNMENT_ATOM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns 503 CASE_ATOM_UNAVAILABLE, not an empty list, when the Case atom's ids fan-in answers non-ok (distinct from the scope call failing)", async () => {
    const scope = {
      items: [
        {
          caseId: caseIdA,
          assignmentId: assignmentIdA,
          participation: "CURRENT",
        },
      ],
      page: 1,
      pageSize: 25,
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes("/api/assignments/contractor/")) {
        return Response.json(scope);
      }
      // The Case atom's `?ids=` fan-in call.
      return new Response("boom", { status: 500 });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: recoveryContractorAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "CASE_ATOM_UNAVAILABLE", retryable: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still produces a 401 (not a 500) when the authenticate middleware throws an HTTPException, proving app.onError()'s HTTPException special-case", async () => {
    const fetchImpl = vi.fn();
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: throwingUnauthorizedAuth,
    });

    const response = await app.request("/api/cases");

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
    // `HTTPException.getResponse()` is a *passthrough*, not the common
    // envelope AC1 asks for elsewhere: it is plaintext, not
    // `{ error: { code, retryable } }`. This is pre-existing `hono/jwk`
    // behaviour app.onError() deliberately preserves rather than reshapes
    // (see the comment above app.onError() in app.ts) — not a 151-B
    // regression — but it means auth 401s are the one read response still
    // outside the JSON envelope, worth flagging forward for 151-F's
    // envelope-aware frontend parsing.
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Unauthorized");
  });

  it("keeps GET /api/cases, POST /api/cases, and GET /api/cases/:caseId reachable with their own response shapes (no shadowing)", async () => {
    const caseRecord = { ...baseCaseRecord, id: caseIdA };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      // The Officer detail route reads the internal, un-redacted Case route
      // (PRS-151 Task 2) — a singular `case`, not the public `cases` array.
      if (href.includes("/internal/cases/")) {
        return Response.json({ case: caseRecord });
      }
      if (href.includes("/api/appointments")) {
        return Response.json({ appointments: [] });
      }
      if (href.includes("/api/assignments")) {
        return Response.json({ assignment: null, attempt: null });
      }
      // Both the list route's `?page&pageSize` call and the detail route's
      // `/api/cases/:caseId` call land here.
      return Response.json({ cases: [caseRecord] });
    });
    const { app } = createApp(undefined, fetchImpl, {
      authenticate: officerAuth,
    });

    const listResponse = await app.request("/api/cases");
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.data).toMatchObject({ page: 1, pageSize: 25 });
    expect(listBody.data.items).toHaveLength(1);

    const postResponse = await app.request("/api/cases", {
      method: "POST",
      headers: {
        "Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    expect(postResponse.status).toBe(201);
    const postBody = await postResponse.json();
    expect(postBody.data.id).toBe(successResult.data.id);
    expect(postBody.data).not.toHaveProperty("items");

    const detailResponse = await app.request(`/api/cases/${caseIdA}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.data.id).toBe(caseIdA);
    expect(detailBody.data).toHaveProperty("assignment");
    expect(detailBody.data).not.toHaveProperty("items");
  });
});

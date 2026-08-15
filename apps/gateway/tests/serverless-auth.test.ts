import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp, successResult, workerServiceToken } from "./helpers";

const caseId = successResult.data.id;

/**
 * Cloud Run IAM authenticates on `Authorization`, which `workerAuth`
 * (`@townops/shared-ts`) already owns for the shared Worker token — so the
 * Gateway's ID token travels in `X-Serverless-Authorization` instead,
 * alongside `Authorization` unchanged (PRS-140 Phase 5). Every atom call the
 * Gateway makes funnels through the one `fetchImpl`/`rawFetchImpl` closure in
 * `createGatewayApp`, so this exercises it via a single route rather than all
 * of them.
 */
describe("Gateway Cloud Run IAM identity header (PRS-140 Phase 5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attaches X-Serverless-Authorization alongside the existing Authorization header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ effects: [] }));
    const mintIdentityToken = vi.fn().mockResolvedValue("minted-id-token");
    const { app } = createApp(undefined, fetchImpl, { mintIdentityToken });

    const response = await app.request(`/api/cases/${caseId}/effects`);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-id-token"
    );
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
    expect(mintIdentityToken).toHaveBeenCalledWith("http://localhost:5002");
  });

  it("omits X-Serverless-Authorization when the minter returns nothing (local dev default)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ effects: [] }));
    // No `mintIdentityToken` override — falls back to the real
    // `getIdentityToken`, which the root vitest.config.ts defaults to
    // METADATA_SERVER=off for every workspace.
    const { app } = createApp(undefined, fetchImpl);

    const response = await app.request(`/api/cases/${caseId}/effects`);

    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("X-Serverless-Authorization")).toBe(false);
    expect(headers.get("Authorization")).toBe(`Bearer ${workerServiceToken}`);
  });

  it("omits the header when METADATA_SERVER=off is set explicitly", async () => {
    vi.stubEnv("METADATA_SERVER", "off");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ effects: [] }));
    const { app } = createApp(undefined, fetchImpl);

    await app.request(`/api/cases/${caseId}/effects`);

    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers(init?.headers).has("X-Serverless-Authorization")).toBe(
      false
    );
  });
});

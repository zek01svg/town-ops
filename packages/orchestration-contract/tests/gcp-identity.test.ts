import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getIdentityToken, withServerlessAuth } from "../src/gcp-identity";

function fakeToken(expEpochSeconds: number) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: expEpochSeconds })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("getIdentityToken", () => {
  beforeEach(() => {
    // The root vitest.config.ts defaults METADATA_SERVER=off for every
    // workspace; these tests exercise the real minting path, so they opt
    // back in per test.
    vi.stubEnv("METADATA_SERVER", "on");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("makes one network call for two requests inside the TTL", async () => {
    const audience = "https://example-inside-ttl.a.run.app";
    const token = fakeToken(Math.floor(Date.now() / 1000) + 3600);
    const fetchMock = vi.fn().mockResolvedValue(new Response(token));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getIdentityToken(audience);
    const second = await getIdentityToken(audience);

    expect(first).toBe(token);
    expect(second).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(audience)),
      { headers: { "Metadata-Flavor": "Google" } }
    );
  });

  it("refetches once the cached token is within its refresh skew of expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const audience = "https://example-after-expiry.a.run.app";
    const tokenA = fakeToken(120);
    const tokenB = fakeToken(240);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(tokenA))
      .mockResolvedValueOnce(new Response(tokenB));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getIdentityToken(audience);
    expect(first).toBe(tokenA);

    // 61s in: within the 60s refresh skew of tokenA's 120s expiry.
    vi.setSystemTime(61_000);
    const second = await getIdentityToken(audience);

    expect(second).toBe(tokenB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes no network call when METADATA_SERVER=off", async () => {
    vi.stubEnv("METADATA_SERVER", "off");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getIdentityToken("https://example-off.a.run.app");

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined and caches unavailability when the metadata server is unreachable", async () => {
    const audience = "https://example-unreachable.a.run.app";
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getIdentityToken(audience);
    const second = await getIdentityToken(audience);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // The second call reused the negative cache instead of retrying.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("withServerlessAuth", () => {
  it("adds X-Serverless-Authorization alongside the caller's own headers", async () => {
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    const wrapped = withServerlessAuth(
      inner,
      vi.fn().mockResolvedValue("minted-token")
    );

    await wrapped("https://atom.example/api/things", {
      headers: { Authorization: "Bearer worker-token" },
    });

    expect(inner).toHaveBeenCalledTimes(1);
    const [url, init] = inner.mock.calls[0];
    expect(url).toBe("https://atom.example/api/things");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Serverless-Authorization")).toBe(
      "Bearer minted-token"
    );
    expect(headers.get("Authorization")).toBe("Bearer worker-token");
  });

  it("calls fetchImpl unchanged when the minter returns nothing", async () => {
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    const wrapped = withServerlessAuth(
      inner,
      vi.fn().mockResolvedValue(undefined)
    );
    const init = { headers: { Authorization: "Bearer worker-token" } };

    await wrapped("https://atom.example/api/things", init);

    expect(inner).toHaveBeenCalledWith("https://atom.example/api/things", init);
  });
});

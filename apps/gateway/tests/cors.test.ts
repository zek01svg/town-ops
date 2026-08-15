import { describe, expect, it } from "vitest";

import { createApp } from "./helpers";

function preflight(app: ReturnType<typeof createApp>["app"], origin: string) {
  return app.request("/api/cases", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
    },
  });
}

/** `GatewayDependencies.browserOrigins` — the deployed-environment escape
 * hatch from the hardcoded localhost dev-port Set (PRS-140 Phase 5). */
describe("Gateway CORS origins (PRS-140 Phase 5)", () => {
  it("accepts an origin from an injected browserOrigins list", async () => {
    const { app } = createApp(undefined, undefined, {
      browserOrigins: ["https://officer.example.com"],
    });

    const response = await preflight(app, "https://officer.example.com");

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://officer.example.com"
    );
  });

  it("rejects an origin outside an injected browserOrigins list", async () => {
    const { app } = createApp(undefined, undefined, {
      browserOrigins: ["https://officer.example.com"],
    });

    const response = await preflight(app, "http://localhost:3001");

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("falls back to the localhost dev-port default when browserOrigins is not injected", async () => {
    const { app } = createApp();

    const response = await preflight(app, "http://localhost:3001");

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3001"
    );
  });
});

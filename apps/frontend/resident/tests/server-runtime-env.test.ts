// @vitest-environment node
//
// `server/index.ts` is Bun/Node server code, never browser code — running it
// under this file's default jsdom environment makes `window` exist, which
// trips `@townops/shared-ts`'s `env-core` "server var accessed on the
// client" guard the moment `logger` is imported.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `server/index.ts` reads `./build/index.html` once at module load — a
// fresh checkout has no `build/` until `pnpm build` runs, so this fixture
// stands in for it and restores whatever (if anything) was there before.
const BUILD_DIR = "./build";
const INDEX_HTML_PATH = "./build/index.html";
const FIXTURE_HTML =
  "<!doctype html><html><head><title>resident</title></head><body></body></html>";

let existedBefore: boolean;
let originalContent: string | undefined;

beforeAll(() => {
  existedBefore = existsSync(INDEX_HTML_PATH);
  if (existedBefore) {
    originalContent = readFileSync(INDEX_HTML_PATH, "utf-8");
  } else {
    mkdirSync(BUILD_DIR, { recursive: true });
  }
  writeFileSync(INDEX_HTML_PATH, FIXTURE_HTML);
});

afterAll(() => {
  if (existedBefore && originalContent !== undefined) {
    writeFileSync(INDEX_HTML_PATH, originalContent);
  } else {
    rmSync(INDEX_HTML_PATH, { force: true });
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resident frontend server runtime env injection (PRS-140 Phase 5)", () => {
  it("injects window.__env with the environment's own VITE_GATEWAY_URL into /", async () => {
    vi.stubEnv("VITE_GATEWAY_URL", "https://example.test");
    // A real breakout payload, so the escaping assertion below can
    // actually fail. Without a value containing "<" the check is vacuous.
    vi.stubEnv(
      "VITE_APP_URL",
      "https://x.test/</script><script>alert(1)</script>"
    );
    // `server/index.ts` imports `@townops/shared-ts`, whose barrel eagerly
    // evaluates `otel.ts`'s own `createEnv()` — these are that schema's
    // required vars, not this test's; this app's own `.env` doesn't set them
    // because nothing here imported server code before.
    // Distinct per frontend: turbo runs the three frontend test tasks in
    // parallel, so a shared port makes whichever loses the race fail.
    vi.stubEnv("PORT", "3002");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=test");
    // `server/index.ts` imports `serveStatic` from `hono/bun`, whose barrel
    // destructures `Bun` at module load regardless of which export is used —
    // real under the app's actual Bun runtime, absent under vitest's Node
    // one. This route is never reached by the "/" request below (it returns
    // before the `serveStatic` chain), so a property that merely exists is
    // enough to satisfy the destructure without exercising real Bun behavior.
    vi.stubGlobal("Bun", { write: async () => undefined });
    const { default: server } = await import("../server/index");

    const response = await server.fetch(
      new Request("http://localhost/", { method: "GET" })
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("window.__env");
    expect(html).toContain("https://example.test");

    // `injectRuntimeEnv` claims unset keys are omitted rather than shipped as
    // "" -- the client's `env.ts` falls back through `??`, which an empty
    // string would defeat (it is not nullish).
    expect(html).not.toContain('VITE_GOOGLE_MAPS_API_KEY:""');
    expect(html).not.toContain('VITE_GOOGLE_MAPS_API_KEY: ""');

    // `<` must be escaped so a value containing "</script>" cannot close the
    // tag early and inject markup. This is the injection defence -- without a
    // test it is one refactor away from silently disappearing.
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\u003c");
  }, 30_000);
});

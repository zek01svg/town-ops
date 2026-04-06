import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["hono"],
    alias: {
      "hono/jwk": fileURLToPath(
        new URL("./__stubs__/hono-jwk.ts", import.meta.url)
      ),
      "hono/client": fileURLToPath(
        new URL("./__stubs__/hono-client.ts", import.meta.url)
      ),
    },
  },
  test: {
    environment: "node",
    globalSetup: fileURLToPath(new URL("./global-setup.ts", import.meta.url)),
    include: ["./**/*.test.ts"],
    exclude: ["node_modules", "dist", "build"],
    testTimeout: 60_000,
    reporters: ["dot"],
    alias: {
      "@townops/shared-ts": fileURLToPath(
        new URL("../../packages/shared-ts/src/index.ts", import.meta.url)
      ),
    },
    server: {
      deps: {
        inline: [/hono/],
      },
    },
  },
});

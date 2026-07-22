import { fileURLToPath, URL } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../../tooling/vitest/vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      globalSetup: "./tests/integration/global-setup.ts",
      // Integration suites share one Testcontainers database and truncate
      // tables between tests, so they must not run against each other.
      fileParallelism: false,
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@townops/shared-ts": fileURLToPath(
          new URL("../../../packages/shared-ts/src/index.ts", import.meta.url)
        ),
      },
    },
  })
);

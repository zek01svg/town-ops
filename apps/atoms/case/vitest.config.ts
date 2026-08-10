import { fileURLToPath, URL } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig, isUnitRun } from "../../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      globalSetup: isUnitRun
        ? undefined
        : "./tests/integration/global-setup.ts",
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@townops/shared-ts": fileURLToPath(
          new URL("../../../packages/shared-ts/src/index.ts", import.meta.url)
        ),
      },
    },
  })
);

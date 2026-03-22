import { fileURLToPath, URL } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../../tooling/vitest/vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      globalSetup: "./tests/integration/global-setup.ts",
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  })
);

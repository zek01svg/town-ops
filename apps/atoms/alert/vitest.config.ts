import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../../../tooling/vitest/vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      globalSetup: "./tests/integration/global-setup.ts",
    },
  })
);

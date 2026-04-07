import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../../../tooling/vitest/vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./tests/setup.ts"],
    },
  })
);

import { defineConfig } from "vitest/config";

import { baseConfig } from "../../../vitest.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    globalSetup: "./tests/integration/global-setup.ts",
    // Integration suites share one Testcontainers database and truncate tables
    // between tests, so they must not run against each other.
    fileParallelism: false,
  },
});

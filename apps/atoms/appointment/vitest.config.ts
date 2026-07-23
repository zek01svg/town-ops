import { defineConfig } from "vitest/config";

import baseVitestConfig from "../../../tooling/vitest/vitest.config";

export default defineConfig({
  ...baseVitestConfig,
  test: {
    ...baseVitestConfig.test,
    globalSetup: "./tests/integration/global-setup.ts",
    // Integration suites share one Testcontainers database, so a second
    // integration file (start-work.test.ts) must not run concurrently with
    // appointment.test.ts's blanket per-test table deletes — same fix as
    // the assignment atom's vitest.config.ts.
    fileParallelism: false,
  },
});

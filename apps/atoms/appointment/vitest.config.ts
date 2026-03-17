import { defineConfig } from "vitest/config";

import baseConfig from "../../../tooling/vitest/vitest.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    globalSetup: "./tests/integration/global-setup.ts",
  },
});

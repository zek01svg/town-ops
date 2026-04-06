import { fileURLToPath, URL } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../../../tooling/vitest/vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      coverage: {
        provider: "istanbul",
        reporter: ["text", "json", "html"],
        include: ["src/**/*.ts"],
        exclude: ["src/env.ts", "src/validation-schemas.ts"],
      },
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@townops/shared-ts": fileURLToPath(
          new URL("../../../packages/shared-ts/src/index.ts", import.meta.url)
        ),
      },
    },
  })
);

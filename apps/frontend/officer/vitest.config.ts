import { fileURLToPath, URL } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "../../../tooling/vitest/vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@/components/ui": fileURLToPath(
          new URL("../../../packages/ui/src/components/ui", import.meta.url)
        ),
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./tests/setup.ts"],
    },
  })
);

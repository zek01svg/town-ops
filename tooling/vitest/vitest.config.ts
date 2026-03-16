import { fileURLToPath, URL } from "node:url";

import { defineConfig, defineProject, mergeConfig } from "vitest/config";

export const baseConfig = defineConfig({
  test: {
    exclude: [
      "node_modules",
      ".venv",
      "coverage",
      "dist",
      ".next",
      "playwright",
      "../../tests/e2e",
    ],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    coverage: {
      provider: "istanbul" as const,
      reporter: [
        ["json", { subdir: "json" }],
        ["html", { subdir: "html" }],
      ] as const,
      enabled: true,
    },
    reporters: ["dot"],
  },
});

const vitestConfig = mergeConfig(
  baseConfig,
  defineProject({
    test: {
      environment: "jsdom",
    },
  })
);

export default vitestConfig;

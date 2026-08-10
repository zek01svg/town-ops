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
      "tests/e2e",
    ],
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

// Detects a `vitest run tests/unit` invocation so atoms whose unit suite
// mocks the database can skip the Testcontainers-backed globalSetup that the
// full (Docker-requiring) suite needs.
export const isUnitRun = process.argv.some((arg) => arg.includes("tests/unit"));

const vitestConfig = mergeConfig(
  baseConfig,
  defineProject({
    test: {
      environment: "node",
    },
  })
);

export default vitestConfig;

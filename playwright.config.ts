import { defineConfig, devices } from "@playwright/test";

// Compose publishes the frontends on 3001/3002/3003 (docker-compose.yml:516-541);
// the suite assumes a running stack, since there is no `webServer` below.
// Override for `vite dev` (5173/5174/5175) via the env vars.
const OFFICER_URL = process.env.OFFICER_URL ?? "http://localhost:3001";
const CONTRACTOR_URL = process.env.CONTRACTOR_URL ?? "http://localhost:3002";
const RESIDENT_URL = process.env.RESIDENT_URL ?? "http://localhost:3003";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  outputDir: "playwright/test-results",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: "officer-setup",
      testMatch: /.*officer\.setup\.ts/,
      use: { baseURL: OFFICER_URL },
    },
    {
      name: "contractor-setup",
      testMatch: /.*contractor\.setup\.ts/,
      use: { baseURL: CONTRACTOR_URL },
    },
    {
      name: "resident-setup",
      testMatch: /.*resident\.setup\.ts/,
      use: { baseURL: RESIDENT_URL },
    },
    {
      name: "officer",
      testMatch: /.*officer.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: OFFICER_URL,
        storageState: "playwright/.auth/officer.json",
      },
      dependencies: ["officer-setup", "contractor-setup"],
    },
    {
      name: "contractor",
      testMatch: /.*contractor.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: CONTRACTOR_URL,
        storageState: "playwright/.auth/contractor.json",
      },
      dependencies: ["contractor-setup"],
    },
    {
      name: "resident",
      testMatch: /.*resident.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: RESIDENT_URL,
        storageState: "playwright/.auth/resident.json",
      },
      dependencies: ["resident-setup"],
    },
  ],
});

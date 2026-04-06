import path from "path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "../../node_modules/dotenv/lib/main.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const OFFICER_URL    = process.env.OFFICER_URL    ?? "http://localhost:4001";
const CONTRACTOR_URL = process.env.CONTRACTOR_URL ?? "http://localhost:4000";
const RESIDENT_URL   = process.env.RESIDENT_URL   ?? "http://localhost:4002";

export default defineConfig({
  testDir: "../../tests/e2e",
  fullyParallel: false, // scenarios share state (RabbitMQ/DB); run sequentially
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
    // ── Auth setup (one per app) ────────────────────────────────────────────
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

    // ── Test suites ─────────────────────────────────────────────────────────
    {
      name: "officer",
      testMatch: /.*officer.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: OFFICER_URL,
        storageState: "playwright/.auth/officer.json",
      },
      dependencies: ["officer-setup"],
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
      },
    },
  ],
});

import path from "path";

/**
 * Playwright auth setup for the Contractor frontend.
 * Logs in once, saves storage state so contractor specs skip the login flow.
 */
import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = path.resolve("playwright/.auth/contractor.json");

setup("contractor login", async ({ page }) => {
  await page.goto("/");

  // Use the first contractor by default; override via env for specific tests
  await page
    .getByLabel(/email/i)
    .fill(process.env.CONTRACTOR_EMAIL ?? "aljunied@townops.dev");
  await page
    .getByLabel(/password/i)
    .fill(process.env.CONTRACTOR_PASSWORD ?? "Contractor@123");
  await page.getByRole("button", { name: /sign in|log in/i }).click();

  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_FILE });
});

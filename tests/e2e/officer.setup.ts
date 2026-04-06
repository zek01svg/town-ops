/**
 * Playwright auth setup for the Officer frontend.
 * Logs in once, saves storage state so officer specs skip the login flow.
 */
import { test as setup, expect } from "@playwright/test";
import path from "path";

const AUTH_FILE = path.resolve("playwright/.auth/officer.json");

setup("officer login", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel(/email/i).fill(process.env.OFFICER_EMAIL ?? "amk@townops.dev");
  await page.getByLabel(/password/i).fill(process.env.OFFICER_PASSWORD ?? "Officer@123");
  await page.getByRole("button", { name: /sign in|log in/i }).click();

  // Wait for the dashboard to load after successful login
  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_FILE });
});

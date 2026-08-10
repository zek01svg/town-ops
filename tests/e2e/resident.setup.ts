import path from "path";

import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = path.resolve("playwright/.auth/resident.json");

setup("resident login", async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel(/email/i)
    .fill(process.env.RESIDENT_EMAIL ?? "resident@townops.dev");
  await page
    .getByLabel(/password/i)
    .fill(process.env.RESIDENT_PASSWORD ?? "Resident@123");
  await page.getByRole("button", { name: /login/i }).click();

  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
  await page.context().storageState({ path: AUTH_FILE });
});

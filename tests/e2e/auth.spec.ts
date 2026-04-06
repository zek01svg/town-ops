/**
 * E2E: Auth flows (shared, run against officer app)
 *
 * Covers:
 * - Login page visible at root
 * - Login fails with wrong credentials
 * - Successful login redirects to dashboard
 * - Logged-out user cannot access dashboard directly
 */

import { test, expect } from "@playwright/test";

// These run without saved auth state (don't depend on setup project)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Authentication", () => {
  test("login page is accessible at root", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("shows error on wrong credentials", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/email/i).fill("wrong@townops.dev");
    await page.getByLabel(/password/i).fill("WrongPassword123");
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    await expect(
      page.getByText(/invalid|incorrect|failed|unauthorized/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });

  test("redirects unauthenticated /dashboard visit to login", async ({ page }) => {
    await page.goto("/dashboard");
    // Should land back at root or /login
    await expect(page).toHaveURL(/\/$|\/login/, { timeout: 8_000 });
  });

  test("successful officer login redirects to dashboard", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/email/i).fill(process.env.OFFICER_EMAIL ?? "amk@townops.dev");
    await page.getByLabel(/password/i).fill(process.env.OFFICER_PASSWORD ?? "Officer@123");
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
  });
});

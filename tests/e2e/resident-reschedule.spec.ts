/**
 * E2E: Resident Reschedule Flow
 *
 * Covers:
 * - Login page renders
 * - Unauthenticated users are redirected to login
 * - Reschedule form renders after login
 * - Form validates required UUIDs and datetime fields
 */

import { test, expect } from "@playwright/test";

test.describe("Resident Reschedule", () => {
  test("login page renders with email and password fields", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in|log in/i })
    ).toBeVisible();
  });

  test("unauthenticated visit to /dashboard redirects to login", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/$|\/login/, { timeout: 8_000 });
  });

  test("shows validation error on invalid UUID fields", async ({ page }) => {
    // Log in first with a resident account (uses real auth)
    await page.goto("/");
    await page
      .getByLabel(/email/i)
      .fill(process.env.RESIDENT_EMAIL ?? "resident@townops.dev");
    await page
      .getByLabel(/password/i)
      .fill(process.env.RESIDENT_PASSWORD ?? "Resident@123");
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

    // Fill in obviously invalid UUIDs
    await page.getByLabel(/case id/i).fill("not-a-uuid");
    await page.getByRole("button", { name: /confirm reschedule/i }).click();

    const error = page.locator(".text-destructive, [role='alert'], em");
    await expect(error.first()).toBeVisible({ timeout: 5_000 });
  });

  test("reschedule form fields are all present", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel(/email/i)
      .fill(process.env.RESIDENT_EMAIL ?? "resident@townops.dev");
    await page
      .getByLabel(/password/i)
      .fill(process.env.RESIDENT_PASSWORD ?? "Resident@123");
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

    await expect(page.getByLabel(/case id/i)).toBeVisible();
    await expect(page.getByLabel(/assignment id/i)).toBeVisible();
    await expect(page.getByLabel(/resident id/i)).toBeVisible();
    await expect(page.getByLabel(/new start time/i)).toBeVisible();
    await expect(page.getByLabel(/new end time/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /confirm reschedule/i })
    ).toBeVisible();
  });
});

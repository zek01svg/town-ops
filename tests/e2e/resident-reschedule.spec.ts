/**
 * E2E: Resident Reschedule Flow
 *
 * Covers:
 * - Unauthenticated users are redirected to login
 * - Seeded Resident sees the current reschedule interface
 */

import { test, expect } from "@playwright/test";

test.describe("Resident Reschedule", () => {
  test("unauthenticated visit to /dashboard redirects to login", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/$|\/login/, { timeout: 8_000 });
  });

  test("shows the reschedule form for the seeded Resident", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/resident service desk/i)).toBeVisible();
    await expect(page.getByText(/reschedule a visit/i)).toBeVisible();
    await expect(page.getByText(/select a case/i)).toBeVisible();
    await expect(page.getByLabel(/new start time/i)).toBeVisible();
    await expect(page.getByLabel(/new end time/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /confirm reschedule/i })
    ).toBeDisabled();
  });
});

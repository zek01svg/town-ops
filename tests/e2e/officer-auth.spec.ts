/**
 * E2E authentication checks run in the Officer project without saved state.
 */
import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Officer authentication", () => {
  test("login page is accessible at root", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("shows error on wrong credentials", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/email/i).fill("wrong@townops.dev");
    await page.getByLabel(/password/i).fill("WrongPassword123");
    await page.getByRole("button", { name: /login/i }).click();

    await expect(
      page.getByText(/invalid|incorrect|failed|unauthorized/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });

  test("successful officer login redirects to dashboard", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel(/email/i)
      .fill(process.env.OFFICER_EMAIL ?? "amk@townops.dev");
    await page
      .getByLabel(/password/i)
      .fill(process.env.OFFICER_PASSWORD ?? "Officer@123");
    await page.getByRole("button", { name: /login/i }).click();

    await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
  });
});

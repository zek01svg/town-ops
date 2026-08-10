/**
 * E2E: Officer Dashboard
 *
 * Covers:
 * - Dashboard loads with case list
 * - Officer can open the New Case form
 * - Kanban board shows cases in correct columns
 */

import { test, expect } from "@playwright/test";

test.describe("Officer Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    // Wait for the board to finish loading
    await expect(page.getByText(/loading/i)).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("shows dashboard with stat cards", async ({ page }) => {
    await expect(page.getByText(/active cases/i)).toBeVisible();
    await expect(page.getByText(/total cases/i)).toBeVisible();
    await expect(page.getByText(/resolved/i).first()).toBeVisible();
  });

  test("Kanban board renders with expected columns", async ({ page }) => {
    await expect(page.getByText(/pending/i).first()).toBeVisible();
    await expect(page.getByText(/active/i).first()).toBeVisible();
    await expect(page.getByText(/resolved/i).first()).toBeVisible();
  });

  test("New Case button opens the form sheet", async ({ page }) => {
    await page.getByRole("button", { name: /open new case/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/create new case/i)).toBeVisible();
  });

  test("New Case form exposes its current controls", async ({ page }) => {
    await page.getByRole("button", { name: /open new case/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/resident uuid/i)).toBeVisible();
    await expect(
      dialog.locator('input[placeholder*="123e4567-e89b-12d3"]')
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: /open case/i })
    ).toBeVisible();
  });
});

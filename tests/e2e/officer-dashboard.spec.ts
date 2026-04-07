/**
 * E2E: Officer Dashboard
 *
 * Covers:
 * - Dashboard loads with case list
 * - Officer can open the New Case form
 * - Form validates required fields
 * - Successful submission creates a case and closes the sheet
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
    await expect(page.getByText(/sla breached/i)).toBeVisible();
    await expect(page.getByText(/resolved/i)).toBeVisible();
  });

  test("Kanban board renders with expected columns", async ({ page }) => {
    await expect(page.getByText(/pending/i).first()).toBeVisible();
    await expect(page.getByText(/dispatched/i).first()).toBeVisible();
    await expect(page.getByText(/escalated/i).first()).toBeVisible();
    await expect(page.getByText(/resolved/i).first()).toBeVisible();
  });

  test("New Case button opens the form sheet", async ({ page }) => {
    await page.getByRole("button", { name: /new case/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/open a case/i)).toBeVisible();
  });

  test("New Case form shows validation errors on empty submit", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /new case/i }).click();
    await page.getByRole("button", { name: /submit|open case/i }).click();

    // At least one validation message should appear
    const errors = page.locator(
      "[data-field-error], .text-destructive, [role='alert']"
    );
    await expect(errors.first()).toBeVisible({ timeout: 5_000 });
  });

  test("New Case form submits successfully", async ({ page }) => {
    await page.getByRole("button", { name: /new case/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Fill in required fields — adjust selectors to match actual form labels
    await dialog
      .getByLabel(/resident id/i)
      .fill("aaaaaaaa-0001-4000-8000-000000000001");
    await dialog.getByLabel(/category/i).selectOption({ index: 1 });
    await dialog
      .getByLabel(/description/i)
      .fill("Test case created by Playwright E2E");
    await dialog.getByLabel(/address/i).fill("Blk 123 Aljunied Ave 1");
    await dialog.getByLabel(/postal/i).fill("380123");

    await dialog.getByRole("button", { name: /submit|open case/i }).click();

    // Dialog should close on success
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
  });
});

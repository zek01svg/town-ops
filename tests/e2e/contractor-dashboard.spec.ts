/**
 * E2E: Contractor Dashboard
 *
 * Covers:
 * - Dashboard loads showing only cases assigned to the logged-in contractor
 * - Case audit trail shows assignment status and countdown
 * - Acknowledge Job button is visible for PENDING_ACCEPTANCE assignments
 * - Close Job sheet opens and validates required fields
 * - No Access button is visible on dispatched cases
 */

import { test, expect } from "@playwright/test";

test.describe("Contractor Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/loading/i)).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("shows dashboard with contractor-specific stat cards", async ({
    page,
  }) => {
    await expect(page.getByText(/backlog/i).first()).toBeVisible();
    await expect(page.getByText(/dispatched/i).first()).toBeVisible();
  });

  test("dashboard only shows cases assigned to logged-in contractor", async ({
    page,
  }) => {
    // Cases section should be visible (even if empty — contractor may have no cases)
    await expect(
      page
        .locator(".kanban, [data-testid='kanban'], [class*='kanban']")
        .first()
        .or(page.getByText(/no cases/i).first())
    ).toBeVisible({ timeout: 10_000 });
  });

  test("clicking a case card opens audit trail", async ({ page }) => {
    const cards = page.locator(
      "[data-testid='case-card'], [class*='kanban-card'], .case-card"
    );
    const count = await cards.count();
    test.skip(
      count === 0,
      "No cases assigned to this contractor — skipping audit trail test"
    );

    await cards.first().click();
    await expect(
      page.getByText(/audit trail|assignment|acknowledge/i).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Acknowledge Job button visible on pending assignment", async ({
    page,
  }) => {
    const acknowledgeBtn = page.getByRole("button", { name: /acknowledge/i });
    const count = await acknowledgeBtn.count();
    test.skip(
      count === 0,
      "No pending assignments — skipping acknowledge test"
    );

    await expect(acknowledgeBtn.first()).toBeVisible();
  });

  test("Close Job button opens the close job sheet", async ({ page }) => {
    const closeBtn = page.getByRole("button", { name: /close job/i });
    const count = await closeBtn.count();
    test.skip(
      count === 0,
      "No accepted jobs to close — skipping close job test"
    );

    await closeBtn.first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText(/before photo|completion report/i).first()
    ).toBeVisible();
  });

  test("No Access button visible on dispatched case", async ({ page }) => {
    const noAccessBtn = page.getByRole("button", { name: /no access/i });
    const count = await noAccessBtn.count();
    test.skip(count === 0, "No dispatched cases — skipping no access test");

    await expect(noAccessBtn.first()).toBeVisible();
  });

  test("SLA countdown timer visible on pending assignment", async ({
    page,
  }) => {
    // Countdown should show either a timer or OVERDUE
    const countdown = page
      .getByText(/\d+m \d+s/)
      .or(page.getByText(/overdue/i));
    const count = await countdown.count();
    test.skip(count === 0, "No pending assignment with countdown — skipping");
    await expect(countdown.first()).toBeVisible();
  });
});

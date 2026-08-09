import path from "path";

/**
 * Playwright auth setup for the Contractor frontend.
 * Logs in once, saves storage state so contractor specs skip the login flow.
 */
import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = path.resolve("playwright/.auth/contractor.json");
const CONTRACTOR_ID = "22222222-2222-4222-8222-222222222222";

setup("contractor login", async ({ page }) => {
  await page.goto("/");

  // Use the first contractor by default; override via env for specific tests
  await page
    .getByLabel(/email/i)
    .fill(process.env.CONTRACTOR_EMAIL ?? "aljunied@townops.dev");
  await page
    .getByLabel(/password/i)
    .fill(process.env.CONTRACTOR_PASSWORD ?? "Contractor@123");
  await page.getByRole("button", { name: /login/i }).click();

  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

  const token = await page.evaluate(() => localStorage.getItem("jwt"));
  if (!token) throw new Error("Contractor login did not issue a JWT.");
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
  );
  expect(payload).toMatchObject({
    name: "E2E Contractor",
    email: "aljunied@townops.dev",
    role: "CONTRACTOR",
    contractorId: CONTRACTOR_ID,
  });

  await page.context().storageState({ path: AUTH_FILE });
});

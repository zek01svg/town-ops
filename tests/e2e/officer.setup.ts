import path from "path";

/**
 * Playwright auth setup for the Officer frontend.
 * Logs in once, saves storage state so officer specs skip the login flow.
 */
import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = path.resolve("playwright/.auth/officer.json");

setup("officer login", async ({ page }) => {
  await page.goto("/");

  await page
    .getByLabel(/email/i)
    .fill(process.env.OFFICER_EMAIL ?? "amk@townops.dev");
  await page
    .getByLabel(/password/i)
    .fill(process.env.OFFICER_PASSWORD ?? "Officer@123");
  await page.getByRole("button", { name: /login/i }).click();

  // Wait for the dashboard to load after successful login
  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });

  const token = await page.evaluate(() => localStorage.getItem("jwt"));
  if (!token) throw new Error("Officer login did not issue a JWT.");
  const payload: unknown = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
  );
  expect(payload).toMatchObject({
    name: "E2E Officer",
    email: "amk@townops.dev",
    role: "OFFICER",
    contractorId: null,
  });

  await page.context().storageState({ path: AUTH_FILE });
});

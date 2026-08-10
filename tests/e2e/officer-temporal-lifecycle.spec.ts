import { expect, test } from "@playwright/test";
import type { APIResponse, Page } from "@playwright/test";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:6010";
const OFFICER_URL = process.env.OFFICER_URL ?? "http://localhost:3001";
const CONTRACTOR_URL = process.env.CONTRACTOR_URL ?? "http://localhost:3002";
const RESIDENT_ID = "aaaaaaaa-0001-4000-8000-000000000001";

function headers(token: string, idempotencyKey?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object.`);
  return value;
}

function string(objectValue: Record<string, unknown>, key: string): string {
  const value = objectValue[key];
  if (typeof value !== "string") throw new Error(`${key} was not a string.`);
  return value;
}

async function data(response: APIResponse) {
  const body: unknown = await response.json();
  return object(object(body, "response").data, "response.data");
}

async function tokenFor(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem("jwt"));
  if (!token) throw new Error("Expected a frontend-issued JWT.");
  return token;
}

function currentAttemptStatus(body: unknown): string | undefined {
  if (
    !isRecord(body) ||
    !isRecord(body.data) ||
    !isRecord(body.data.assignment)
  ) {
    return undefined;
  }
  const attempt = body.data.assignment.currentAttempt;
  return isRecord(attempt) && typeof attempt.status === "string"
    ? attempt.status
    : undefined;
}

function status(result: Record<string, unknown>, field: string) {
  return string(object(result[field], `response.data.${field}`), "status");
}

test("Officer to Contractor lifecycle runs through Gateway and Temporal", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const officerContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const contractorContext = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });

  try {
    const officerPage = await officerContext.newPage();
    await officerPage.goto(OFFICER_URL);
    await officerPage
      .getByLabel(/email/i)
      .fill(process.env.OFFICER_EMAIL ?? "amk@townops.dev");
    await officerPage
      .getByLabel(/password/i)
      .fill(process.env.OFFICER_PASSWORD ?? "Officer@123");
    await officerPage.getByRole("button", { name: /login/i }).click();
    await expect(officerPage).toHaveURL(/dashboard/, { timeout: 15_000 });
    const officerToken = await tokenFor(officerPage);

    const contractorPage = await contractorContext.newPage();
    await contractorPage.goto(CONTRACTOR_URL);
    await contractorPage
      .getByLabel(/email/i)
      .fill(process.env.CONTRACTOR_EMAIL ?? "aljunied@townops.dev");
    await contractorPage
      .getByLabel(/password/i)
      .fill(process.env.CONTRACTOR_PASSWORD ?? "Contractor@123");
    await contractorPage.getByRole("button", { name: /login/i }).click();
    await expect(contractorPage).toHaveURL(/dashboard/, { timeout: 15_000 });
    const contractorToken = await tokenFor(contractorPage);

    const open = await request.post(`${GATEWAY_URL}/api/cases`, {
      headers: headers(officerToken, crypto.randomUUID()),
      data: {
        residentId: RESIDENT_ID,
        category: "LE",
        priority: "MEDIUM",
        description: `PRS-206 lifecycle ${crypto.randomUUID()}`,
        addressDetails: "123 E2E Street",
        postalCode: "380123",
      },
    });
    expect(open.status()).toBe(201);
    const caseId = string(await data(open), "id");

    await expect
      .poll(
        async () => {
          const response = await request.get(
            `${GATEWAY_URL}/api/cases/${caseId}`,
            { headers: headers(officerToken) }
          );
          if (!response.ok()) return undefined;
          const body: unknown = await response.json();
          return currentAttemptStatus(body);
        },
        { timeout: 30_000 }
      )
      .toBe("PENDING_ACCEPTANCE");

    const allocated = await request.get(`${GATEWAY_URL}/api/cases/${caseId}`, {
      headers: headers(officerToken),
    });
    expect(allocated.ok()).toBeTruthy();
    const allocation = await data(allocated);
    const attemptId = string(
      object(
        object(allocation.assignment, "response.data.assignment")
          .currentAttempt,
        "response.data.assignment.currentAttempt"
      ),
      "id"
    );
    const startTime = new Date(Date.now() + 45_000).toISOString();
    const endTime = new Date(Date.parse(startTime) + 15_000).toISOString();

    const accept = await request.put(
      `${GATEWAY_URL}/api/cases/${caseId}/allocation-attempts/${attemptId}/acceptance`,
      {
        headers: headers(contractorToken, crypto.randomUUID()),
        data: { startTime, endTime },
      }
    );
    expect(accept.status()).toBe(200);
    const appointmentId = string(
      object((await data(accept)).appointment, "response.data.appointment"),
      "id"
    );

    await officerPage.waitForTimeout(
      Math.max(0, Date.parse(startTime) - Date.now() + 250)
    );
    const start = await request.put(
      `${GATEWAY_URL}/api/cases/${caseId}/appointments/${appointmentId}/start-work`,
      { headers: headers(contractorToken, crypto.randomUUID()) }
    );
    expect(start.status()).toBe(200);
    expect(status(await data(start), "case")).toBe("IN_PROGRESS");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = async (type: "BEFORE" | "AFTER") => {
      const response = await request.post(
        `${GATEWAY_URL}/api/cases/${caseId}/proof-items`,
        {
          headers: headers(contractorToken, crypto.randomUUID()),
          multipart: {
            type,
            file: {
              name: `${type.toLowerCase()}.png`,
              mimeType: "image/png",
              buffer: png,
            },
          },
        }
      );
      expect(response.status()).toBe(201);
      return string(await data(response), "id");
    };

    const proofItemIds = [await upload("BEFORE"), await upload("AFTER")];
    const complete = await request.put(
      `${GATEWAY_URL}/api/cases/${caseId}/completion`,
      {
        headers: headers(contractorToken, crypto.randomUUID()),
        data: { report: "PRS-206 lifecycle completed.", proofItemIds },
      }
    );
    expect(complete.status()).toBe(200);
    const result = await data(complete);
    expect(status(result, "appointment")).toBe("COMPLETED");
    expect(status(result, "case")).toBe("COMPLETED");
  } finally {
    await contractorContext.close();
    await officerContext.close();
  }
});

/**
 * Integration: Scenario 3 — No Access / Reschedule
 *
 * Tests the no-access reporting path and the reschedule path:
 *   contractor PUT /api/cases/no-access → case set to pending_resident_input + case.no_access published
 *   resident  POST /api/cases/reschedule-job → new appointment + case restored to dispatched
 *
 * hono/jwk and hono/client are aliased to stubs in vitest.config.ts.
 * mockHc is imported directly from the stub so both the app and the test share the same vi.fn() instance.
 */

import { AMQPClient } from "@cloudamqp/amqp-client";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.hoisted(() => {
  process.env.PORT = "0";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.RESIDENT_ATOM_URL = "http://resident-atom";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.APPOINTMENT_ATOM_URL = "http://appointment-atom";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
  process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
});

const mockRabbitmqClient = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(true),
  publishToQueue: vi.fn().mockResolvedValue(true),
}));

vi.mock("@townops/shared-ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  honoLogger: () => (_c: any, next: any) => next(),
  rabbitmqClient: mockRabbitmqClient,
  corsOrigins: () => ["http://localhost:5173"],
  initSentry: vi.fn(),
  captureHonoException: vi.fn(),
}));

import { app as noAccessApp } from "../../apps/composites/handle-no-access/src/index";
import { app as rescheduleApp } from "../../apps/composites/reschedule-job/src/index";
/* eslint-disable import/first */
import { hc as mockHc } from "./__stubs__/hono-client";
/* eslint-enable import/first */

const CASE_ID = "cccccccc-0001-4000-8000-000000000001";
const ASSIGNMENT_ID = "cccccccc-0002-4000-8000-000000000002";
const CONTRACTOR_ID = "c0ffee01-0003-4000-8000-000000000003";
const RESIDENT_ID = "cccccccc-0004-4000-8000-000000000004";
const APPOINTMENT_ID = "cccccccc-0005-4000-8000-000000000005";

describe("Scenario 3 — No Access / Reschedule", () => {
  let amqp: AMQPClient;

  beforeAll(async () => {
    const url = process.env.RABBITMQ_URL;
    if (!url) throw new Error("RABBITMQ_URL missing — global-setup didn't run");
    amqp = new AMQPClient(url);
    await amqp.connect();
  }, 60_000);

  afterAll(async () => {
    await amqp.close();
  });

  describe("Handle No Access", () => {
    it("sets case to pending_resident_input and publishes case.no_access", async () => {
      const ch = await amqp.channel();
      await ch.exchangeDeclare("townops.events", "topic", { durable: true });
      const q = await ch.queueDeclare("", {
        autoDelete: true,
        exclusive: true,
      });
      await ch.queueBind(q.name, "townops.events", "case.no_access");

      await ch.basicConsume(q.name, { noAck: true }, (_msg) => {});

      vi.mocked(mockHc).mockImplementation((url: string) => {
        if (url === "http://case-atom") {
          return {
            api: {
              cases: {
                ":id": {
                  $get: vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                      id: CASE_ID,
                      residentId: RESIDENT_ID,
                    }),
                  }),
                },
                "update-case-status": {
                  $put: vi
                    .fn()
                    .mockResolvedValue({ ok: true, json: async () => ({}) }),
                },
              },
            },
          };
        }
        if (url === "http://resident-atom") {
          return {
            api: {
              residents: {
                ":id": {
                  $get: vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                      id: RESIDENT_ID,
                      email: "resident@townops.dev",
                    }),
                  }),
                },
              },
            },
          };
        }
        return {};
      });

      const res = await noAccessApp.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          assignmentId: ASSIGNMENT_ID,
          contractorId: CONTRACTOR_ID,
          reason: "Gate was locked",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("pending_resident_input");

      await new Promise((r) => setTimeout(r, 600));

      expect(mockRabbitmqClient.publish).toHaveBeenCalledWith(
        "townops.events",
        "case.no_access",
        expect.objectContaining({
          caseId: CASE_ID,
          residentId: RESIDENT_ID,
          message: "Gate was locked",
        })
      );

      await ch.queueDelete(q.name);
    });

    it("returns 400 on missing caseId", async () => {
      const res = await noAccessApp.request("/api/cases/no-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractorId: CONTRACTOR_ID }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Reschedule Job", () => {
    const startTime = new Date(Date.now() + 86_400_000)
      .toISOString()
      .replace("Z", "+08:00");
    const endTime = new Date(Date.now() + 90_000_000)
      .toISOString()
      .replace("Z", "+08:00");

    it("creates new appointment and restores case to dispatched", async () => {
      vi.mocked(mockHc).mockImplementation((url: string) => {
        if (url === "http://resident-atom") {
          return {
            api: {
              residents: {
                ":id": {
                  $get: vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                      residents: { id: RESIDENT_ID, is_active: true },
                    }),
                  }),
                },
              },
            },
          };
        }
        if (url === "http://appointment-atom") {
          return {
            api: {
              appointments: {
                $post: vi.fn().mockResolvedValue({
                  ok: true,
                  json: async () => ({
                    appointment: {
                      id: APPOINTMENT_ID,
                      caseId: CASE_ID,
                      status: "rescheduled",
                    },
                  }),
                }),
              },
            },
          };
        }
        if (url === "http://case-atom") {
          return {
            api: {
              cases: {
                "update-case-status": {
                  $put: vi.fn().mockResolvedValue({
                    ok: true,
                    json: async () => ({
                      cases: { id: CASE_ID, status: "dispatched" },
                    }),
                  }),
                },
              },
            },
          };
        }
        return {};
      });

      const res = await rescheduleApp.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          residentId: RESIDENT_ID,
          assignmentId: ASSIGNMENT_ID,
          newStartTime: startTime,
          newEndTime: endTime,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("rescheduled");
      expect(data.appointmentId).toBe(APPOINTMENT_ID);
      expect(data.caseId).toBe(CASE_ID);
    });

    it("returns 400 on invalid datetime format", async () => {
      const res = await rescheduleApp.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          residentId: RESIDENT_ID,
          assignmentId: ASSIGNMENT_ID,
          newStartTime: "not-a-date",
          newEndTime: "also-not-a-date",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when resident not found", async () => {
      vi.mocked(mockHc).mockImplementation((url: string) => {
        if (url === "http://resident-atom") {
          return {
            api: {
              residents: {
                ":id": {
                  $get: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
                },
              },
            },
          };
        }
        return {};
      });

      const res = await rescheduleApp.request("/api/cases/reschedule-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId: CASE_ID,
          residentId: RESIDENT_ID,
          assignmentId: ASSIGNMENT_ID,
          newStartTime: startTime,
          newEndTime: endTime,
        }),
      });

      expect(res.status).toBe(404);
    });
  });
});

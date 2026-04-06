/**
 * Integration: Scenario 2 — SLA Breach
 *
 * Verifies the breach path:
 *   sla.breached event → handleSlaBreach → case escalated + case.escalated published
 *
 * RabbitMQ runs in a real Testcontainer (via global-setup.ts).
 * All atom HTTP calls are mocked with globalThis.fetch.
 */

import { AMQPClient } from "@cloudamqp/amqp-client";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.hoisted(() => {
  process.env.PORT = "0";
  process.env.CASE_ATOM_URL = "http://case-atom";
  process.env.ASSIGNMENT_ATOM_URL = "http://assignment-atom";
  process.env.METRICS_ATOM_URL = "http://metrics-atom";
  process.env.CONTRACTOR_API_URL = "http://contractor-api";
  process.env.JWKS_URI = "http://localhost/.well-known/jwks.json";
});

/* eslint-disable import/first */
import { handleSlaBreach } from "../../apps/composites/handle-breach/src/worker";
/* eslint-enable import/first */

const CASE_ID = "bbbbbbbb-0001-4000-8000-000000000001";
const ASSIGNMENT_ID = "bbbbbbbb-0002-4000-8000-000000000002";
const CONTRACTOR_ID = "c0ffee01-0003-4000-8000-000000000003";
const NEW_WORKER_ID = "c0ffee01-0099-4000-8000-000000000099";
const POSTAL_CODE = "51234";
const CATEGORY_CODE = "PLUMBING";

describe("Scenario 2 — SLA Breach", () => {
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

  function mockFetch(assignmentStatus: string) {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, opts?: RequestInit) => {
        // GET assignment by case_id
        if (url.includes(`/api/assignments/${CASE_ID}`) && !opts?.method) {
          return {
            ok: true,
            json: async () => ({
              assignments: { id: ASSIGNMENT_ID, status: assignmentStatus },
            }),
          };
        }
        // GET search contractors
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [
              { ContractorUuid: CONTRACTOR_ID },
              { ContractorUuid: NEW_WORKER_ID },
            ],
          };
        }
        // PUT reassign assignment
        if (url.includes("/api/assignments/") && opts?.method === "PUT") {
          return { ok: true, json: async () => ({ assignments: {} }) };
        }
        // PUT update-case-status
        if (url.includes("/api/cases/update-case-status")) {
          return { ok: true, json: async () => ({ cases: {} }) };
        }
        // POST metrics
        if (url.includes("/api/metrics")) {
          return { ok: true, json: async () => ({ metric: {} }) };
        }
        return { ok: false, status: 404 };
      }) as unknown as typeof fetch;
  }

  it("publishes case.escalated after processing sla.breached", async () => {
    mockFetch("PENDING_ACCEPTANCE");

    const ch = await amqp.channel();
    await ch.exchangeDeclare("townops.events", "topic", { durable: true });
    const q = await ch.queueDeclare("", { autoDelete: true, exclusive: true });
    await ch.queueBind(q.name, "townops.events", "case.escalated");

    let received: any = null;
    await ch.basicConsume(q.name, { noAck: true }, (msg) => {
      received = JSON.parse(msg.bodyString() ?? "{}");
    });

    await handleSlaBreach(
      JSON.stringify({
        assignment_id: ASSIGNMENT_ID,
        case_id: CASE_ID,
        contractor_id: CONTRACTOR_ID,
        postal_code: POSTAL_CODE,
        category_code: CATEGORY_CODE,
      })
    );

    await new Promise((r) => setTimeout(r, 600));

    expect(received).not.toBeNull();
    expect(received).toMatchObject({
      caseId: CASE_ID,
      assignmentId: ASSIGNMENT_ID,
      newWorkerId: NEW_WORKER_ID,
    });

    await ch.queueDelete(q.name);
  });

  it("skips escalation if assignment is already ACCEPTED", async () => {
    mockFetch("ACCEPTED");

    const ch = await amqp.channel();
    await ch.exchangeDeclare("townops.events", "topic", { durable: true });
    const q = await ch.queueDeclare("", { autoDelete: true, exclusive: true });
    await ch.queueBind(q.name, "townops.events", "case.escalated");

    let received: any = null;
    await ch.basicConsume(q.name, { noAck: true }, (msg) => {
      received = JSON.parse(msg.bodyString() ?? "{}");
    });

    await handleSlaBreach(
      JSON.stringify({
        assignment_id: ASSIGNMENT_ID,
        case_id: CASE_ID,
        contractor_id: CONTRACTOR_ID,
        postal_code: POSTAL_CODE,
        category_code: CATEGORY_CODE,
      })
    );

    await new Promise((r) => setTimeout(r, 600));

    expect(received).toBeNull();

    // Contractor search should not have been called
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const searchCalls = fetchMock.mock.calls.filter((c: any[]) =>
      (c[0] as string).includes("/contractors/search")
    );
    expect(searchCalls.length).toBe(0);

    await ch.queueDelete(q.name);
  });

  it("throws when contractor search fails (triggers NACK + retry)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url.includes(`/api/assignments/${CASE_ID}`) && !opts?.method) {
          return {
            ok: true,
            json: async () => ({
              assignments: { id: ASSIGNMENT_ID, status: "PENDING_ACCEPTANCE" },
            }),
          };
        }
        if (url.includes("/contractors/search")) {
          return { ok: false, status: 503 };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

    await expect(
      handleSlaBreach(
        JSON.stringify({
          assignment_id: ASSIGNMENT_ID,
          case_id: CASE_ID,
          contractor_id: CONTRACTOR_ID,
          postal_code: POSTAL_CODE,
          category_code: CATEGORY_CODE,
        })
      )
    ).rejects.toThrow("Contractor search failed");
  });

  it("throws when no backup contractor is available", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url.includes(`/api/assignments/${CASE_ID}`) && !opts?.method) {
          return {
            ok: true,
            json: async () => ({
              assignments: { id: ASSIGNMENT_ID, status: "PENDING_ACCEPTANCE" },
            }),
          };
        }
        // Only returns the current contractor — no backup available
        if (url.includes("/contractors/search")) {
          return {
            ok: true,
            json: async () => [{ ContractorUuid: CONTRACTOR_ID }],
          };
        }
        return { ok: false };
      }) as unknown as typeof fetch;

    await expect(
      handleSlaBreach(
        JSON.stringify({
          assignment_id: ASSIGNMENT_ID,
          case_id: CASE_ID,
          contractor_id: CONTRACTOR_ID,
          postal_code: POSTAL_CODE,
          category_code: CATEGORY_CODE,
        })
      )
    ).rejects.toThrow("No backup contractor available");
  });

  it("drops message silently on unparseable payload", async () => {
    await expect(handleSlaBreach("{bad json")).resolves.toBeUndefined();
  });

  it("drops message silently on missing required fields", async () => {
    await expect(
      handleSlaBreach(JSON.stringify({ some: "garbage" }))
    ).resolves.toBeUndefined();
  });
});

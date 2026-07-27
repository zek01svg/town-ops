import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  UPDATE_NAMES,
  WORKFLOW_NAMES,
} from "@townops/orchestration-contract";
import type {
  AppointmentStatus,
  MarkCaseAppointmentReplacedInput,
  MarkCaseAppointmentReplacedResult,
  MarkCaseNoAccessInput,
  MarkCaseNoAccessResult,
  ReplaceAppointmentCommand,
  ReplaceAppointmentSlotInput,
  ReplaceAppointmentSlotResult,
  ReportNoAccessAppointmentInput,
  ReportNoAccessAppointmentResult,
  ReportNoAccessCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The reportNoAccess and replaceAppointment Update handlers (PRS-146 AC1/AC4/
 * AC5/AC9).
 *
 * Both gates are plain `Date.now()` comparisons inside the Update handler
 * rather than Workflow timers, so they read the Workflow's clock — which under
 * `createTimeSkipping()` is the test server's, not the wall clock. Windows are
 * therefore built from `isoAt`, which is pinned to that same clock (see
 * below). A boundary is only observable to the resolution dispatch latency
 * allows, so the tests pin "before", "inside" and "after" with margins, which
 * is what catches a missing or inverted gate.
 */

const contractorId = "11111111-1111-4111-8111-111111111111";

// Offsets are relative to the clock the gate itself reads. Under
// `createTimeSkipping()` the Workflow's `Date.now()` is the test server's
// clock, not the wall clock, and the two differ by however long the suite has
// been running — enough that a wall-clock base puts a zero offset *ahead* of
// the Workflow's "now" and makes a just-opened window read as NOT_IN_WINDOW.
// The offset is re-measured before every test, because it drifts across a
// suite this long. Even then it is only good to the dispatch latency between
// building a command and the handler reading its clock, so boundaries below
// are asserted with a margin rather than at the exact instant.
let clockSkewMs = 0;

function isoAt(offsetMs: number) {
  return new Date(Date.now() + clockSkewMs + offsetMs).toISOString();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function noAccessCommand(params: {
  caseId: string;
  assignmentId: string;
  appointmentId: string;
  startOffsetMs: number;
  endOffsetMs: number;
  idempotencyKey?: string;
  payloadHash?: string;
}): ReportNoAccessCommand {
  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const payloadHash = params.payloadHash ?? "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "CONTRACTOR",
    contractorId,
    caseId: params.caseId,
    appointmentId: params.appointmentId,
    startTime: isoAt(params.startOffsetMs),
    endTime: isoAt(params.endOffsetMs),
  };
}

function replaceCommand(params: {
  caseId: string;
  appointmentId: string;
  newStartOffsetMs: number;
  newEndOffsetMs: number;
  previousStartOffsetMs: number;
  previousStatus: AppointmentStatus;
  idempotencyKey?: string;
  payloadHash?: string;
}): ReplaceAppointmentCommand {
  const idempotencyKey = params.idempotencyKey ?? randomUUID();
  const payloadHash = params.payloadHash ?? "a".repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole: "RESIDENT",
    caseId: params.caseId,
    appointmentId: params.appointmentId,
    input: {
      startTime: isoAt(params.newStartOffsetMs),
      endTime: isoAt(params.newEndOffsetMs),
      reason: "Nobody was home",
    },
    previousStartTime: isoAt(params.previousStartOffsetMs),
    previousStatus: params.previousStatus,
  };
}

/** Every fake Activity the two Sagas need, recording every call it sees. */
type Recorded = {
  noAccessCalls: ReportNoAccessAppointmentInput[];
  replaceCalls: ReplaceAppointmentSlotInput[];
  caseNoAccessCalls: MarkCaseNoAccessInput[];
  caseReplacedCalls: MarkCaseAppointmentReplacedInput[];
  callOrder: string[];
};

function newRecorder(): Recorded {
  return {
    noAccessCalls: [],
    replaceCalls: [],
    caseNoAccessCalls: [],
    caseReplacedCalls: [],
    callOrder: [],
  };
}

function appointmentDto(
  appointmentId: string,
  caseId: string,
  status: AppointmentStatus,
  operationId: string
) {
  return {
    id: appointmentId,
    caseId,
    assignmentId: randomUUID(),
    attemptId: randomUUID(),
    contractorId,
    startTime: "2030-01-01T09:00:00.000Z",
    endTime: "2030-01-01T10:00:00.000Z",
    status,
    reason: null,
    operationId,
    createdAt: new Date().toISOString(),
  };
}

function caseDto(
  caseId: string,
  status: "PENDING_RESIDENT_INPUT" | "ASSIGNED"
) {
  const now = new Date().toISOString();
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "LE" as const,
    priority: "HIGH" as const,
    status,
    description: "Broken street light",
    addressDetails: null,
    postalCode: "123456",
    createdAt: now,
    updatedAt: now,
  };
}

type ActivityConfig = {
  recorded: Recorded;
  reportNoAccessAppointment?: (
    input: ReportNoAccessAppointmentInput
  ) =>
    | Promise<ReportNoAccessAppointmentResult>
    | ReportNoAccessAppointmentResult;
  markCaseNoAccess?: (
    input: MarkCaseNoAccessInput
  ) => Promise<MarkCaseNoAccessResult> | MarkCaseNoAccessResult;
  replaceAppointmentSlot?: (
    input: ReplaceAppointmentSlotInput
  ) => Promise<ReplaceAppointmentSlotResult> | ReplaceAppointmentSlotResult;
  markCaseAppointmentReplaced?: (
    input: MarkCaseAppointmentReplacedInput
  ) =>
    | Promise<MarkCaseAppointmentReplacedResult>
    | MarkCaseAppointmentReplacedResult;
};

function makeActivities(config: ActivityConfig) {
  const { recorded } = config;
  return {
    reportNoAccessAppointment: async (
      input: ReportNoAccessAppointmentInput
    ) => {
      recorded.noAccessCalls.push(input);
      recorded.callOrder.push("appointment");
      if (config.reportNoAccessAppointment) {
        return config.reportNoAccessAppointment(input);
      }
      return {
        outcome: "NO_ACCESS" as const,
        appointment: appointmentDto(
          input.appointmentId,
          randomUUID(),
          "NO_ACCESS",
          input.operationId
        ),
      };
    },
    markCaseNoAccess: async (input: MarkCaseNoAccessInput) => {
      recorded.caseNoAccessCalls.push(input);
      recorded.callOrder.push("case");
      if (config.markCaseNoAccess) return config.markCaseNoAccess(input);
      return {
        outcome: "PENDING_RESIDENT_INPUT" as const,
        case: caseDto(input.caseId, "PENDING_RESIDENT_INPUT"),
      };
    },
    replaceAppointmentSlot: async (input: ReplaceAppointmentSlotInput) => {
      recorded.replaceCalls.push(input);
      recorded.callOrder.push("appointment");
      if (config.replaceAppointmentSlot) {
        return config.replaceAppointmentSlot(input);
      }
      return {
        outcome: "REPLACED" as const,
        appointment: appointmentDto(
          randomUUID(),
          input.caseId,
          "SCHEDULED",
          `${input.operationId}/appointment`
        ),
      };
    },
    markCaseAppointmentReplaced: async (
      input: MarkCaseAppointmentReplacedInput
    ) => {
      recorded.caseReplacedCalls.push(input);
      recorded.callOrder.push("case");
      if (config.markCaseAppointmentReplaced) {
        return config.markCaseAppointmentReplaced(input);
      }
      return {
        outcome: "REPLACED" as const,
        case: caseDto(input.caseId, "ASSIGNED"),
      };
    },
  };
}

function startWorkflowAndCall(
  client: Client,
  updateName: string,
  workflowId: string,
  taskQueue: string,
  caseId: string,
  command: ReportNoAccessCommand | ReplaceAppointmentCommand
) {
  return client.workflow.executeUpdateWithStart(updateName, {
    args: [command],
    updateId: randomUUID(),
    startWorkflowOperation: new WithStartWorkflowOperation(
      WORKFLOW_NAMES.case,
      {
        workflowId,
        taskQueue,
        args: [{ caseId }],
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }
    ),
  });
}

describe("No access and reschedule Updates (PRS-146)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  beforeEach(async () => {
    clockSkewMs = (await env.currentTimeMs()) - Date.now();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  async function createCaseWorker(
    activities: ReturnType<typeof makeActivities>
  ) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities,
    });
    return { worker, taskQueue };
  }

  describe("reportNoAccess window gate (AC9)", () => {
    it("inside the window succeeds and runs the Saga appointment-then-case, once each", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId,
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -1_000,
            endOffsetMs: 60_000,
          })
        );

        expect(result).toMatchObject({
          kind: "SUCCESS",
          data: {
            appointment: { status: "NO_ACCESS" },
            case: { status: "PENDING_RESIDENT_INPUT" },
          },
        });
        expect(recorded.callOrder).toEqual(["appointment", "case"]);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("is allowed as soon as the window has opened", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        // A window that opened a moment ago. The margin is deliberate: the
        // test server's clock cannot be read precisely enough to pin the exact
        // `>=` instant, and a 1ms-wide distinction between `>` and `>=` on the
        // lower bound has no behavioural consequence. The upper bound below is
        // where half-open actually earns its keep.
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId,
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -2_000,
            endOffsetMs: 60_000,
          })
        );

        expect(result).toMatchObject({ kind: "SUCCESS" });
        expect(recorded.noAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("before startTime is NOT_IN_WINDOW and is not cached — the same key succeeds once the window opens", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const command = noAccessCommand({
          caseId,
          assignmentId: randomUUID(),
          appointmentId: randomUUID(),
          startOffsetMs: 3_000,
          endOffsetMs: 60_000,
        });
        const early = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          command
        );

        expect(early).toEqual({ kind: "NOT_IN_WINDOW" });
        expect(recorded.noAccessCalls).toHaveLength(0);
        expect(recorded.caseNoAccessCalls).toHaveLength(0);

        await waitUntil(() => Date.now() >= Date.parse(command.startTime) + 20);
        const retried = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.reportNoAccess, {
            args: [command],
            updateId: randomUUID(),
          });

        expect(retried).toMatchObject({ kind: "SUCCESS" });
        expect(recorded.noAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("at or after endTime is NOT_IN_WINDOW without calling any atom", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        // The clock has passed endTime while startTime is well behind it: a
        // half-open [start, end) window must reject this, and an inclusive
        // upper bound or an absent one would let it through.
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId,
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -60_000,
            endOffsetMs: -2_000,
          })
        );

        expect(result).toEqual({ kind: "NOT_IN_WINDOW" });
        expect(recorded.noAccessCalls).toHaveLength(0);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("replays a cached SUCCESS after the window has closed instead of NOT_IN_WINDOW", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        // The load-bearing ordering: the idempotency cache is consulted before
        // the window gate, so a retry of an in-window report that only lands
        // after endTime must replay rather than be rejected.
        const command = noAccessCommand({
          caseId,
          assignmentId: randomUUID(),
          appointmentId: randomUUID(),
          startOffsetMs: -1_000,
          endOffsetMs: 2_500,
        });
        const first = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          command
        );
        expect(first).toMatchObject({ kind: "SUCCESS" });

        await waitUntil(() => Date.now() >= Date.parse(command.endTime) + 200);
        const replay = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.reportNoAccess, {
            args: [command],
            updateId: randomUUID(),
          });

        expect(replay).toEqual(first);
        expect(recorded.noAccessCalls).toHaveLength(1);
        expect(recorded.caseNoAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("the same idempotencyKey with a different payloadHash returns IDEMPOTENCY_KEY_REUSED", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const command = noAccessCommand({
          caseId,
          assignmentId: randomUUID(),
          appointmentId: randomUUID(),
          startOffsetMs: -1_000,
          endOffsetMs: 60_000,
        });
        expect(
          await startWorkflowAndCall(
            client,
            UPDATE_NAMES.reportNoAccess,
            workflowId,
            taskQueue,
            caseId,
            command
          )
        ).toMatchObject({ kind: "SUCCESS" });

        const changed = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.reportNoAccess, {
            args: [
              {
                ...command,
                payloadHash: "b".repeat(64),
                operationId: `${command.idempotencyKey}.${"b".repeat(64)}`,
              },
            ],
            updateId: randomUUID(),
          });

        expect(changed).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
        expect(recorded.noAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a caseId that does not match this Workflow is CASE_MISMATCH without running the Saga", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId: randomUUID(),
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -1_000,
            endOffsetMs: 60_000,
          })
        );

        expect(result).toEqual({ kind: "CASE_MISMATCH" });
        expect(recorded.noAccessCalls).toHaveLength(0);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);
  });

  describe("runNoAccess outcome mapping", () => {
    const cases: {
      label: string;
      atom: ReportNoAccessAppointmentResult;
      expected: unknown;
    }[] = [
      {
        label: "APPOINTMENT_NOT_FOUND -> APPOINTMENT_MISMATCH",
        atom: { outcome: "APPOINTMENT_NOT_FOUND" },
        expected: { kind: "APPOINTMENT_MISMATCH" },
      },
      {
        label: "NOT_SCHEDULED passes through",
        atom: { outcome: "NOT_SCHEDULED" },
        expected: { kind: "NOT_SCHEDULED" },
      },
      {
        label: "WRONG_CONTRACTOR passes through",
        atom: { outcome: "WRONG_CONTRACTOR" },
        expected: { kind: "WRONG_CONTRACTOR" },
      },
    ];

    for (const scenario of cases) {
      it(`${scenario.label}, without touching the Case`, async () => {
        const caseId = randomUUID();
        const workflowId = `case/${caseId}`;
        const recorded = newRecorder();
        const { worker, taskQueue } = await createCaseWorker(
          makeActivities({
            recorded,
            reportNoAccessAppointment: () => scenario.atom,
          })
        );
        const client = new Client({ connection: env.nativeConnection });

        await worker.runUntil(async () => {
          const result = await startWorkflowAndCall(
            client,
            UPDATE_NAMES.reportNoAccess,
            workflowId,
            taskQueue,
            caseId,
            noAccessCommand({
              caseId,
              assignmentId: randomUUID(),
              appointmentId: randomUUID(),
              startOffsetMs: -1_000,
              endOffsetMs: 60_000,
            })
          );

          expect(result).toEqual(scenario.expected);
          expect(recorded.caseNoAccessCalls).toHaveLength(0);

          await client.workflow.getHandle(workflowId).terminate();
        });
      }, 30_000);
    }

    it("an ALREADY_NO_ACCESS Appointment still drives the Case write", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({
          recorded,
          reportNoAccessAppointment: (input) => ({
            outcome: "ALREADY_NO_ACCESS" as const,
            appointment: appointmentDto(
              input.appointmentId,
              caseId,
              "NO_ACCESS",
              input.operationId
            ),
          }),
        })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId,
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -1_000,
            endOffsetMs: 60_000,
          })
        );

        expect(result).toMatchObject({ kind: "SUCCESS" });
        expect(recorded.caseNoAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a terminal Case reports CASE_TERMINAL after the Appointment committed", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({
          recorded,
          markCaseNoAccess: () => ({ outcome: "CASE_TERMINAL" as const }),
        })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.reportNoAccess,
          workflowId,
          taskQueue,
          caseId,
          noAccessCommand({
            caseId,
            assignmentId: randomUUID(),
            appointmentId: randomUUID(),
            startOffsetMs: -1_000,
            endOffsetMs: 60_000,
          })
        );

        expect(result).toEqual({ kind: "CASE_TERMINAL" });
        expect(recorded.noAccessCalls).toHaveLength(1);
        expect(recorded.caseNoAccessCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);
  });

  describe("replaceAppointment time gates (AC4/AC5)", () => {
    it("a future SCHEDULED Appointment moved to a future slot succeeds, appointment then case", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            previousStartOffsetMs: 86_400_000,
            previousStatus: "SCHEDULED",
          })
        );

        expect(result).toMatchObject({
          kind: "SUCCESS",
          data: {
            appointment: { status: "SCHEDULED" },
            case: { status: "ASSIGNED" },
          },
        });
        expect(recorded.callOrder).toEqual(["appointment", "case"]);
        expect(recorded.replaceCalls[0]?.operationId).toMatch(/\/replace$/);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a new startTime at or before now is NOT_FUTURE without calling any atom", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        // Keep a small negative margin: the time-skipping server clock can
        // advance between building the command and dispatching its handler.
        const atNow = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: -2_000,
            newEndOffsetMs: 3_600_000,
            previousStartOffsetMs: 86_400_000,
            previousStatus: "SCHEDULED",
          })
        );
        const inPast = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.replaceAppointment, {
            args: [
              replaceCommand({
                caseId,
                appointmentId: randomUUID(),
                newStartOffsetMs: -3_600_000,
                newEndOffsetMs: 3_600_000,
                previousStartOffsetMs: 86_400_000,
                previousStatus: "SCHEDULED",
              }),
            ],
            updateId: randomUUID(),
          });

        expect(atNow).toEqual({ kind: "NOT_FUTURE" });
        expect(inPast).toEqual({ kind: "NOT_FUTURE" });
        expect(recorded.replaceCalls).toHaveLength(0);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    // The asymmetry AC4/AC5 turns on: with the *new* slot held in the future
    // for both, only previousStatus/previousStartTime can decide the outcome.
    it("a SCHEDULED Appointment whose own start has passed is NOT_FUTURE (AC4)", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            previousStartOffsetMs: -3_600_000,
            previousStatus: "SCHEDULED",
          })
        );

        expect(result).toEqual({ kind: "NOT_FUTURE" });
        expect(recorded.replaceCalls).toHaveLength(0);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a NO_ACCESS Appointment whose start has passed is rescheduled anyway (AC5 recovery)", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            // Identical to the NOT_FUTURE case above but for previousStatus.
            previousStartOffsetMs: -3_600_000,
            previousStatus: "NO_ACCESS",
          })
        );

        expect(result).toMatchObject({
          kind: "SUCCESS",
          data: { case: { status: "ASSIGNED" } },
        });
        expect(recorded.replaceCalls).toHaveLength(1);
        expect(recorded.caseReplacedCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("replays a cached SUCCESS after the booked slot has fallen into the past", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        // Same ordering rule as the No-Access replay: the cache outranks a
        // NOT_FUTURE gate that has since closed under the retry.
        const command = replaceCommand({
          caseId,
          appointmentId: randomUUID(),
          newStartOffsetMs: 2_500,
          newEndOffsetMs: 3_600_000,
          previousStartOffsetMs: 86_400_000,
          previousStatus: "SCHEDULED",
        });
        const first = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          command
        );
        expect(first).toMatchObject({ kind: "SUCCESS" });

        await waitUntil(
          () => Date.now() >= Date.parse(command.input.startTime) + 200
        );
        const replay = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.replaceAppointment, {
            args: [command],
            updateId: randomUUID(),
          });

        expect(replay).toEqual(first);
        expect(recorded.replaceCalls).toHaveLength(1);
        expect(recorded.caseReplacedCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("the same idempotencyKey with a different payloadHash returns IDEMPOTENCY_KEY_REUSED", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const command = replaceCommand({
          caseId,
          appointmentId: randomUUID(),
          newStartOffsetMs: 172_800_000,
          newEndOffsetMs: 176_400_000,
          previousStartOffsetMs: 86_400_000,
          previousStatus: "SCHEDULED",
        });
        expect(
          await startWorkflowAndCall(
            client,
            UPDATE_NAMES.replaceAppointment,
            workflowId,
            taskQueue,
            caseId,
            command
          )
        ).toMatchObject({ kind: "SUCCESS" });

        const changed = await client.workflow
          .getHandle(workflowId)
          .executeUpdate(UPDATE_NAMES.replaceAppointment, {
            args: [
              {
                ...command,
                payloadHash: "b".repeat(64),
                operationId: `${command.idempotencyKey}.${"b".repeat(64)}`,
              },
            ],
            updateId: randomUUID(),
          });

        expect(changed).toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
        expect(recorded.replaceCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a caseId that does not match this Workflow is CASE_MISMATCH without running the Saga", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({ recorded })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId: randomUUID(),
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            previousStartOffsetMs: 86_400_000,
            previousStatus: "SCHEDULED",
          })
        );

        expect(result).toEqual({ kind: "CASE_MISMATCH" });
        expect(recorded.replaceCalls).toHaveLength(0);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);
  });

  describe("runReplaceAppointment outcome mapping", () => {
    const cases: {
      label: string;
      atom: ReplaceAppointmentSlotResult;
      expected: unknown;
    }[] = [
      {
        label: "APPOINTMENT_NOT_FOUND -> APPOINTMENT_MISMATCH",
        atom: { outcome: "APPOINTMENT_NOT_FOUND" },
        expected: { kind: "APPOINTMENT_MISMATCH" },
      },
      {
        label: "CONFLICT -> APPOINTMENT_CONFLICT",
        atom: { outcome: "CONFLICT" },
        expected: { kind: "APPOINTMENT_CONFLICT" },
      },
      {
        label: "NOT_REPLACEABLE passes through",
        atom: { outcome: "NOT_REPLACEABLE" },
        expected: { kind: "NOT_REPLACEABLE" },
      },
      {
        label: "CASE_MISMATCH passes through",
        atom: { outcome: "CASE_MISMATCH" },
        expected: { kind: "CASE_MISMATCH" },
      },
    ];

    for (const scenario of cases) {
      it(`${scenario.label}, without touching the Case`, async () => {
        const caseId = randomUUID();
        const workflowId = `case/${caseId}`;
        const recorded = newRecorder();
        const { worker, taskQueue } = await createCaseWorker(
          makeActivities({
            recorded,
            replaceAppointmentSlot: () => scenario.atom,
          })
        );
        const client = new Client({ connection: env.nativeConnection });

        await worker.runUntil(async () => {
          const result = await startWorkflowAndCall(
            client,
            UPDATE_NAMES.replaceAppointment,
            workflowId,
            taskQueue,
            caseId,
            replaceCommand({
              caseId,
              appointmentId: randomUUID(),
              newStartOffsetMs: 172_800_000,
              newEndOffsetMs: 176_400_000,
              previousStartOffsetMs: 86_400_000,
              previousStatus: "SCHEDULED",
            })
          );

          expect(result).toEqual(scenario.expected);
          expect(recorded.caseReplacedCalls).toHaveLength(0);

          await client.workflow.getHandle(workflowId).terminate();
        });
      }, 30_000);
    }

    it("an ALREADY_REPLACED slot still drives the Case write", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({
          recorded,
          replaceAppointmentSlot: (input) => ({
            outcome: "ALREADY_REPLACED" as const,
            appointment: appointmentDto(
              randomUUID(),
              input.caseId,
              "SCHEDULED",
              `${input.operationId}/appointment`
            ),
          }),
        })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            previousStartOffsetMs: 86_400_000,
            previousStatus: "SCHEDULED",
          })
        );

        expect(result).toMatchObject({ kind: "SUCCESS" });
        expect(recorded.caseReplacedCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);

    it("a terminal Case reports CASE_TERMINAL after the replacement committed", async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const { worker, taskQueue } = await createCaseWorker(
        makeActivities({
          recorded,
          markCaseAppointmentReplaced: () => ({
            outcome: "CASE_TERMINAL" as const,
          }),
        })
      );
      const client = new Client({ connection: env.nativeConnection });

      await worker.runUntil(async () => {
        const result = await startWorkflowAndCall(
          client,
          UPDATE_NAMES.replaceAppointment,
          workflowId,
          taskQueue,
          caseId,
          replaceCommand({
            caseId,
            appointmentId: randomUUID(),
            newStartOffsetMs: 172_800_000,
            newEndOffsetMs: 176_400_000,
            previousStartOffsetMs: 86_400_000,
            previousStatus: "SCHEDULED",
          })
        );

        expect(result).toEqual({ kind: "CASE_TERMINAL" });
        expect(recorded.replaceCalls).toHaveLength(1);
        expect(recorded.caseReplacedCalls).toHaveLength(1);

        await client.workflow.getHandle(workflowId).terminate();
      });
    }, 30_000);
  });
});

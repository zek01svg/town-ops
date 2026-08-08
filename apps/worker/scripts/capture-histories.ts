import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
// Deep-imported because `@temporalio/common` does not re-export this from its
// entry point — the same path `@temporalio/client` itself uses to reach
// `@temporalio/common/lib/errors`.
//
// ponytail: `fixBuffers`, not the neighbouring `historyToJSON`. The latter is
// unusable here: it routes through `toProto3JSON`, which throws
// "don't know how to convert value json/plain" on every Payload's
// `map<string, bytes> metadata` under proto3-json-serializer 2.0.2 — the
// upstream bug the SDK flags in `fixBuffers`' own doc comment, and 2.0.2 is
// the newest release matching the SDK's `^2.0.0` range. `fixBuffers` alone
// still base64s every `bytes` field, which is all the fixture needs:
// `Worker.runReplayHistories` accepts a History object directly (only a
// *string* `eventId` routes it through `historyFromJSON`), and protobufjs
// re-encodes base64 strings and `{low, high}` Longs verbatim. The cost is that
// these fixtures are not proto3-JSON, so `temporal workflow show` cannot read
// them. Swap back to `historyToJSON` if the SDK ever narrows that range past
// 2.0.2, or upstream fixes the map-valued `bytes` case.
import { fixBuffers } from "@temporalio/common/lib/proto-utils.js";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  UPDATE_NAMES,
  WORKFLOW_NAMES,
  residentProvisioningWorkflowId,
} from "@townops/orchestration-contract";
import type {
  AcceptAllocationCommand,
  AllocationAttemptDto,
  AppointmentDto,
  CancelCaseCommand,
  CaseDto,
  CompleteCaseCommand,
  DerivedEffectSummary,
  ManualAllocationCommand,
  OpenCaseCommand,
  ProvisionResidentInput,
  ReplaceAppointmentCommand,
  ReportNoAccessCommand,
  RetryEffectCommand,
  StartWorkCommand,
  WaiveEffectCommand,
} from "@townops/orchestration-contract";

/**
 * Captures one representative Workflow history per Case lifecycle branch, plus
 * Resident provisioning, into `tests/histories/*.json` (PRS-152 AC7).
 * `tests/replay.test.ts` replays those fixtures against the current Worker
 * build. `acceptance-sla-breach`, `missed-appointment`, and `start-work` do
 * force full replay with `maxCachedWorkflows: 0`, but only ever of a history
 * the same code just wrote; these fixtures are the only *frozen* histories
 * this repo replays, and so the only ones that can catch cross-version
 * divergence.
 *
 * Run by hand (`pnpm --filter @townops/worker capture-histories`), never in
 * CI: this needs the ephemeral Temporal server, the replay test does not.
 *
 * Capture against the code as it stands. A history captured against older
 * Workflow code fails replay against newer code — which is the replay test
 * working, but it reds CI for the wrong reason.
 */

const contractorA = "11111111-1111-4111-8111-111111111111";
const contractorB = "22222222-2222-4222-8222-222222222222";
const postalCode = "123456";
const historiesDir = fileURLToPath(
  new URL("../tests/histories", import.meta.url)
);
const caseWorkflowsPath = fileURLToPath(
  new URL("../src/workflows/case-workflow.ts", import.meta.url)
);
const residentWorkflowsPath = fileURLToPath(
  new URL("../src/workflows/resident-provisioning-workflow.ts", import.meta.url)
);
const CONTINUE_AS_NEW_AFTER_EVENTS = 120;
const HISTORY_DRIVER_UPDATES = 30;

/**
 * The time-skipping server's clock runs ahead of wall clock. Every deadline
 * the Workflow compares against its own `Date.now()` — Appointment windows,
 * acceptance deadlines — has to be expressed in the server's terms, exactly as
 * `missed-appointment.test.ts` does.
 */
let clockSkewMs = 0;

function isoAt(offsetMs: number) {
  return new Date(Date.now() + clockSkewMs + offsetMs).toISOString();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(what: string, predicate: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${what}`);
}

function envelope<Role extends string>(actorRole: Role, salt: string) {
  const idempotencyKey = randomUUID();
  const payloadHash = salt.repeat(64);
  return {
    idempotencyKey,
    payloadHash,
    operationId: `${idempotencyKey}.${payloadHash}`,
    actorId: randomUUID(),
    actorRole,
  };
}

function openCommand(): OpenCaseCommand {
  return {
    ...envelope("OFFICER", "a"),
    input: {
      residentId: randomUUID(),
      category: "LE",
      priority: "HIGH",
      description: "Broken street light",
      postalCode,
    },
  };
}

function manualCommand(caseId: string): ManualAllocationCommand {
  return {
    ...envelope("OFFICER", "b"),
    caseId,
    category: "LE",
    postalCode,
    input: { contractorId: contractorA },
  };
}

function acceptCommand(
  caseId: string,
  attempt: AllocationAttemptDto,
  startOffsetMs: number,
  endOffsetMs: number
): AcceptAllocationCommand {
  return {
    ...envelope("CONTRACTOR", "c"),
    contractorId: attempt.contractorId,
    caseId,
    assignmentId: attempt.assignmentId,
    attemptId: attempt.id,
    input: { startTime: isoAt(startOffsetMs), endTime: isoAt(endOffsetMs) },
  };
}

function startWorkCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string
): StartWorkCommand {
  return {
    ...envelope("CONTRACTOR", "d"),
    contractorId: accepted.contractorId,
    caseId: accepted.caseId,
    assignmentId: accepted.assignmentId,
    appointmentId,
    startTime: accepted.input.startTime,
    endTime: accepted.input.endTime,
  };
}

function noAccessCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string
): ReportNoAccessCommand {
  return {
    ...envelope("CONTRACTOR", "e"),
    contractorId: accepted.contractorId,
    caseId: accepted.caseId,
    appointmentId,
    startTime: accepted.input.startTime,
    endTime: accepted.input.endTime,
  };
}

function replaceCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string,
  previousStatus: ReplaceAppointmentCommand["previousStatus"] = "SCHEDULED"
): ReplaceAppointmentCommand {
  return {
    ...envelope("RESIDENT", "f"),
    caseId: accepted.caseId,
    appointmentId,
    previousStatus,
    previousStartTime: accepted.input.startTime,
    input: {
      startTime: isoAt(10 * 60_000),
      endTime: isoAt(11 * 60_000),
      reason: "Resident requested a different day",
    },
  };
}

function completeCommand(
  accepted: AcceptAllocationCommand,
  appointmentId: string
): CompleteCaseCommand {
  return {
    ...envelope("CONTRACTOR", "1"),
    contractorId: accepted.contractorId,
    caseId: accepted.caseId,
    assignmentId: accepted.assignmentId,
    appointmentId,
    input: { report: "Work completed.", proofItemIds: [randomUUID()] },
  };
}

function cancelCommand(caseId: string): CancelCaseCommand {
  return {
    ...envelope("RESIDENT", "2"),
    caseId,
    input: { reason: "No longer needed" },
  };
}

function retryCommand(caseId: string, effectId: string): RetryEffectCommand {
  return {
    ...envelope("OFFICER", "3"),
    caseId,
    effectId,
    input: { acknowledgeDuplicateRisk: false },
  };
}

function waiveCommand(caseId: string, effectId: string): WaiveEffectCommand {
  return {
    ...envelope("OFFICER", "4"),
    caseId,
    effectId,
    input: { reason: "Officer waived the notification" },
  };
}

/** A retryEffect for an effect the Case never had: pure history, no state. */
function noopCommand(caseId: string): RetryEffectCommand {
  return {
    ...envelope("OFFICER", "5"),
    caseId,
    effectId: `${randomUUID()}/never-queued`,
    input: { acknowledgeDuplicateRisk: false },
  };
}

function caseDto(caseId: string, status: CaseDto["status"]): CaseDto {
  return {
    id: caseId,
    residentId: randomUUID(),
    category: "LE",
    priority: "HIGH",
    status,
    description: "Broken street light",
    addressDetails: null,
    postalCode,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function appointmentDto(
  caseId: string,
  appointmentId: string,
  startTime: string,
  endTime: string,
  status: AppointmentDto["status"]
): AppointmentDto {
  return {
    id: appointmentId,
    caseId,
    assignmentId: randomUUID(),
    attemptId: randomUUID(),
    contractorId: contractorA,
    startTime,
    endTime,
    status,
    reason: null,
    operationId: `appointment/${appointmentId}`,
    createdAt: "2026-08-07T00:00:00.000Z",
  };
}

function effectDto(
  id: string,
  status: DerivedEffectSummary["status"]
): DerivedEffectSummary {
  return {
    id,
    caseId: "00000000-0000-0000-0000-000000000000",
    type: "EMAIL",
    purpose: "ATTEMPT_ASSIGNMENT_NOTIFICATION",
    status,
    providerId: null,
    providerIdempotencyKey: id,
    attempts: 1,
    lastError: status === "FAILED" ? "SMTP timeout" : null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    contractorId: null,
    scoreDelta: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

type Recorded = {
  attempts: AllocationAttemptDto[];
  appointments: string[];
  attentions: string[];
  emailDispatches: string[];
};

type ActivityConfig = {
  recorded: Recorded;
  /** Contractors `fetchAllocationSnapshot` offers. */
  candidates?: string[];
  /** ms until a freshly committed Attempt's acceptance deadline. */
  deadlineOffsetMs?: number;
  /** Called before every email delivery; throwing fails that delivery. */
  onEmailDispatch?: (id: string) => Promise<void>;
};

/**
 * One stub set spanning the whole Activity surface the CaseWorkflow proxies.
 * Each scenario drives a different branch through it by sending different
 * Updates, so only genuinely per-scenario behaviour — candidates, deadlines,
 * delivery failure — is a knob.
 */
function makeActivities(config: ActivityConfig) {
  const { recorded } = config;
  const candidates = config.candidates ?? [contractorA];
  const appointmentOf = new Map<string, AppointmentDto>();

  const book = (caseId: string, startTime: string, endTime: string) => {
    const appointment = appointmentDto(
      caseId,
      randomUUID(),
      startTime,
      endTime,
      "SCHEDULED"
    );
    appointmentOf.set(caseId, appointment);
    recorded.appointments.push(appointment.id);
    return appointment;
  };

  return {
    isCaseTerminal: async () => false,
    openCase: async (input: { caseId: string }) =>
      caseDto(input.caseId, "PENDING"),
    fetchAllocationSnapshot: async () => ({
      epoch: 0,
      candidates: candidates.map((contractorId) => ({
        contractorId,
        activeAssignments: 0,
        totalScore: 0,
      })),
    }),
    commitAllocationAttempt: async (input: {
      caseId: string;
      contractorId: string;
      source: AllocationAttemptDto["source"];
      operationId: string;
      actorId: string;
      actorRole: string;
      reason?: string;
      expectedEpoch: number;
    }) => {
      const now = new Date().toISOString();
      const assignmentId = randomUUID();
      const attempt: AllocationAttemptDto = {
        id: randomUUID(),
        assignmentId,
        contractorId: input.contractorId,
        source: input.source,
        status: "PENDING_ACCEPTANCE",
        acceptanceSlaMs: 60_000,
        deadlineAt: isoAt(config.deadlineOffsetMs ?? 60_000),
        actorId: input.actorId,
        actorRole: input.actorRole,
        reason: input.reason ?? null,
        operationId: input.operationId,
        createdAt: now,
      };
      recorded.attempts.push(attempt);
      return {
        outcome: "COMMITTED" as const,
        attempt,
        assignment: {
          id: assignmentId,
          caseId: input.caseId,
          createdAt: now,
          updatedAt: now,
        },
        epoch: input.expectedEpoch + 1,
      };
    },
    markCaseAssigned: async () => "ASSIGNED" as const,
    acceptAllocation: async (input: AcceptAllocationCommand) => {
      const now = new Date().toISOString();
      return {
        kind: "SUCCESS" as const,
        data: {
          assignment: {
            id: input.assignmentId,
            caseId: input.caseId,
            createdAt: now,
            updatedAt: now,
          },
          attempt: {
            id: input.attemptId,
            assignmentId: input.assignmentId,
            contractorId: input.contractorId,
            source: "AUTO_ASSIGN" as const,
            status: "ACCEPTED" as const,
            acceptanceSlaMs: 60_000,
            deadlineAt: now,
            actorId: input.actorId,
            actorRole: input.actorRole,
            reason: null,
            operationId: input.operationId,
            createdAt: now,
          },
          appointment: book(
            input.caseId,
            input.input.startTime,
            input.input.endTime
          ),
        },
      };
    },
    raiseOfficerAttention: async (input: { kind: string }) => {
      recorded.attentions.push(input.kind);
    },
    breachAllocationAttempt: async () => ({ outcome: "BREACHED" as const }),
    markCaseBreached: async () => "PENDING" as const,
    startWorkAppointment: async (input: {
      appointmentId: string;
      contractorId: string;
    }) => ({
      outcome: "STARTED" as const,
      appointment: appointmentDto(
        "",
        input.appointmentId,
        isoAt(-1_000),
        isoAt(60_000),
        "IN_PROGRESS"
      ),
    }),
    markAssignmentInProgress: async (input: { assignmentId: string }) => ({
      outcome: "IN_PROGRESS" as const,
      assignment: {
        id: input.assignmentId,
        caseId: "",
        createdAt: "",
        updatedAt: "",
      },
    }),
    markCaseInProgress: async (input: { caseId: string }) => ({
      outcome: "IN_PROGRESS" as const,
      case: caseDto(input.caseId, "IN_PROGRESS"),
    }),
    reportNoAccessAppointment: async (input: { appointmentId: string }) => ({
      outcome: "NO_ACCESS" as const,
      appointment: appointmentDto(
        "",
        input.appointmentId,
        isoAt(-1_000),
        isoAt(60_000),
        "NO_ACCESS"
      ),
    }),
    markCaseNoAccess: async (input: { caseId: string }) => ({
      outcome: "PENDING_RESIDENT_INPUT" as const,
      case: caseDto(input.caseId, "PENDING_RESIDENT_INPUT"),
    }),
    markAppointmentMissed: async (input: { appointmentId: string }) => ({
      outcome: "MISSED" as const,
      appointment: appointmentDto(
        "",
        input.appointmentId,
        isoAt(-2_000),
        isoAt(-1_000),
        "MISSED"
      ),
    }),
    replaceAppointmentSlot: async (input: {
      caseId: string;
      startTime: string;
      endTime: string;
    }) => ({
      outcome: "REPLACED" as const,
      appointment: book(input.caseId, input.startTime, input.endTime),
    }),
    markCaseAppointmentReplaced: async (input: { caseId: string }) => ({
      outcome: "REPLACED" as const,
      case: caseDto(input.caseId, "ASSIGNED"),
    }),
    validateCompletion: async () => ({ outcome: "READY" as const }),
    completeAppointment: async (input: { appointmentId: string }) => ({
      outcome: "COMPLETED" as const,
      appointment: appointmentDto(
        "",
        input.appointmentId,
        isoAt(-2_000),
        isoAt(-1_000),
        "COMPLETED"
      ),
    }),
    completeAssignment: async (input: { assignmentId: string }) => ({
      outcome: "COMPLETED" as const,
      assignment: {
        id: input.assignmentId,
        caseId: "",
        createdAt: "",
        updatedAt: "",
      },
    }),
    completeCase: async (input: { caseId: string }) => ({
      outcome: "COMPLETED" as const,
      case: caseDto(input.caseId, "COMPLETED"),
    }),
    cancelScheduledAppointment: async (input: { caseId: string }) => {
      const appointment = appointmentOf.get(input.caseId);
      return appointment
        ? { outcome: "CANCELLED" as const, appointment }
        : { outcome: "NO_SCHEDULED_APPOINTMENT" as const };
    },
    cancelAssignmentForCase: async () => ({ outcome: "CANCELLED" as const }),
    cancelCase: async (input: { caseId: string }) => ({
      outcome: "CANCELLED" as const,
      case: caseDto(input.caseId, "CANCELLED"),
    }),
    reserveEffect: async (input: { id: string }) =>
      effectDto(input.id, "PENDING"),
    dispatchEmailEffect: async (input: { id: string }) => {
      recorded.emailDispatches.push(input.id);
      await config.onEmailDispatch?.(input.id);
      return effectDto(input.id, "SENT");
    },
    dispatchPerformanceEffect: async (input: { id: string }) =>
      effectDto(input.id, "SENT"),
    markEffectUnknown: async (id: string) => effectDto(id, "UNKNOWN"),
    retryEffect: async (input: { id: string }) => ({
      kind: "SUCCESS" as const,
      effect: effectDto(input.id, "PENDING"),
    }),
    waiveEffect: async (input: { id: string }) => effectDto(input.id, "WAIVED"),
    raiseDerivedEffectAttention: async () => undefined,
    resolveDerivedEffectAttention: async () => undefined,
    recordPerformanceEntry: async (input: { effectId: string }) =>
      effectDto(input.effectId, "SENT"),
    recordCompletionPerformance: async (input: { effectId: string }) =>
      effectDto(input.effectId, "SENT"),
    provisionResidentProfile: async (input: ProvisionResidentInput) => ({
      id: input.accountId,
      fullName: input.fullName,
      email: input.email,
    }),
  };
}

function newRecorder(): Recorded {
  return {
    attempts: [],
    appointments: [],
    attentions: [],
    emailDispatches: [],
  };
}

/**
 * `fixBuffers` base64s every `bytes` field but leaves protobufjs Longs as
 * `{low, high, unsigned}`, which triples the fixture size and buries every
 * event ID under three fields. Flattening them to numbers re-encodes
 * identically — protobufjs takes a plain number wherever it takes a Long — and
 * every value in a history (event and task IDs, epoch seconds) is far inside
 * 2^53.
 */
function isLong(
  value: object
): value is { low: number; high: number; unsigned: boolean } {
  return (
    "low" in value &&
    typeof value.low === "number" &&
    "high" in value &&
    typeof value.high === "number" &&
    "unsigned" in value &&
    typeof value.unsigned === "boolean"
  );
}

function flattenLongs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flattenLongs);
  if (value === null || typeof value !== "object") return value;
  if (isLong(value)) return value.high * 2 ** 32 + (value.low >>> 0);
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, flattenLongs(nested)])
  );
}

async function main() {
  mkdirSync(historiesDir, { recursive: true });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  clockSkewMs = (await env.currentTimeMs()) - Date.now();
  const client = new Client({ connection: env.nativeConnection });
  const written: { name: string; events: number; bytes: number }[] = [];

  /** Persists one run's history as JSON `Worker.runReplayHistories` can read. */
  async function save(name: string, workflowId: string, runId?: string) {
    const history = await (
      runId
        ? client.workflow.getHandle(workflowId, runId)
        : client.workflow.getHandle(workflowId)
    ).fetchHistory();
    const json = JSON.stringify(flattenLongs(fixBuffers(history)), null, 2);
    writeFileSync(`${historiesDir}/${name}.json`, `${json}\n`);
    written.push({
      name,
      events: history.events?.length ?? 0,
      bytes: json.length,
    });
  }

  /** Runs one scenario against a dedicated Worker and task queue. */
  async function withWorker(
    activities: Record<string, unknown>,
    body: (taskQueue: string) => Promise<void>,
    workflowsPath = caseWorkflowsPath
  ) {
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });
    await worker.runUntil(() => body(taskQueue));
  }

  function updateWithStart(
    taskQueue: string,
    caseId: string,
    updateName: string,
    command: unknown,
    continueAsNewAfterEvents?: number
  ) {
    return client.workflow.executeUpdateWithStart(updateName, {
      args: [command],
      updateId: randomUUID(),
      startWorkflowOperation: new WithStartWorkflowOperation(
        WORKFLOW_NAMES.case,
        {
          workflowId: `case/${caseId}`,
          taskQueue,
          args: [{ caseId, continueAsNewAfterEvents }],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }
      ),
    });
  }

  function update(caseId: string, updateName: string, command: unknown) {
    return client.workflow
      .getHandle(`case/${caseId}`)
      .executeUpdate(updateName, { args: [command], updateId: randomUUID() });
  }

  /**
   * Every Update below is meant to be admitted. A rejected one still produces
   * a plausible-looking history — just not of the branch the fixture claims —
   * and the replay test would happily pass on it, so refuse it here instead.
   */
  async function updateOk(
    caseId: string,
    updateName: string,
    command: unknown
  ) {
    const result: unknown = await update(caseId, updateName, command);
    const kind =
      typeof result === "object" && result !== null && "kind" in result
        ? result.kind
        : undefined;
    if (kind !== "SUCCESS") {
      throw new Error(`${updateName} on ${caseId} returned ${String(kind)}`);
    }
  }

  /**
   * Opens a Case and lets automatic allocation commit its first Attempt, then
   * hands the scenario the Attempt and the accepted Appointment. Every
   * post-acceptance branch below starts from here.
   */
  async function acceptedCase(
    recorded: Recorded,
    taskQueue: string,
    caseId: string,
    windowOffsetMs: { start: number; end: number }
  ) {
    await updateWithStart(
      taskQueue,
      caseId,
      UPDATE_NAMES.openCase,
      openCommand()
    );
    await waitUntil("the first Attempt", () => recorded.attempts.length > 0);
    const [attempt] = recorded.attempts;
    if (!attempt) throw new Error("No Attempt was committed");
    const accepted = acceptCommand(
      caseId,
      attempt,
      windowOffsetMs.start,
      windowOffsetMs.end
    );
    await updateOk(caseId, UPDATE_NAMES.acceptAllocation, accepted);
    const [appointmentId] = recorded.appointments;
    if (!appointmentId) throw new Error("No Appointment was booked");
    return { accepted, appointmentId };
  }

  const runIdOf = async (workflowId: string) =>
    (await client.workflow.getHandle(workflowId).describe()).runId;

  /** Grows one run's history past the threshold without waking its main loop. */
  async function growHistory(caseId: string) {
    const handle = client.workflow.getHandle(`case/${caseId}`);
    for (let i = 0; i < HISTORY_DRIVER_UPDATES; i++) {
      await handle.executeUpdate(UPDATE_NAMES.retryEffect, {
        args: [noopCommand(caseId)],
        updateId: randomUUID(),
      });
    }
  }

  async function waitForNewRun(workflowId: string, previousRunId: string) {
    const deadline = Date.now() + 30_000;
    let runId = previousRunId;
    while (runId === previousRunId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runId = await runIdOf(workflowId);
    }
    if (runId === previousRunId) {
      throw new Error(`${workflowId} never continued as new`);
    }
    return runId;
  }

  try {
    // open -> auto-allocate -> accept -> start work -> complete. Runs to
    // closure, so this fixture covers the terminal path as well.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        const { accepted, appointmentId } = await acceptedCase(
          recorded,
          taskQueue,
          caseId,
          { start: -1_000, end: 5 * 60_000 }
        );
        await updateOk(
          caseId,
          UPDATE_NAMES.startWork,
          startWorkCommand(accepted, appointmentId)
        );
        await updateOk(
          caseId,
          UPDATE_NAMES.completeCase,
          completeCommand(accepted, appointmentId)
        );
        await client.workflow.getHandle(`case/${caseId}`).result();
      });
      await save("case-open-accept-start-complete", `case/${caseId}`);
    })();

    // Acceptance SLA breach with a second eligible Contractor, so the breach
    // is followed by a BREACH_REASSIGN allocation pass.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(
        makeActivities({
          recorded,
          candidates: [contractorA, contractorB],
          deadlineOffsetMs: 2_000,
        }),
        async (taskQueue) => {
          await updateWithStart(
            taskQueue,
            caseId,
            UPDATE_NAMES.openCase,
            openCommand()
          );
          await waitUntil(
            "the replacement Attempt",
            () => recorded.attempts.length > 1
          );
        }
      );
      await save("case-acceptance-sla-breach-reassign", `case/${caseId}`);
    })();

    // Manual allocation by an Officer, with no prior automatic pass.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        await updateWithStart(
          taskQueue,
          caseId,
          UPDATE_NAMES.allocateContractor,
          manualCommand(caseId)
        );
        await waitUntil(
          "the assignment notification",
          () => recorded.emailDispatches.length > 0
        );
      });
      await save("case-manual-allocation", `case/${caseId}`);
    })();

    // No Access reported inside the Appointment window.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        const { accepted, appointmentId } = await acceptedCase(
          recorded,
          taskQueue,
          caseId,
          { start: -1_000, end: 5 * 60_000 }
        );
        await updateOk(
          caseId,
          UPDATE_NAMES.reportNoAccess,
          noAccessCommand(accepted, appointmentId)
        );
        await waitUntil(
          "the no-access notification",
          () => recorded.emailDispatches.length > 1
        );
      });
      await save("case-no-access", `case/${caseId}`);
    })();

    // Proactive reschedule of a still-future SCHEDULED Appointment.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        const { accepted, appointmentId } = await acceptedCase(
          recorded,
          taskQueue,
          caseId,
          { start: 5 * 60_000, end: 6 * 60_000 }
        );
        await updateOk(
          caseId,
          UPDATE_NAMES.replaceAppointment,
          replaceCommand(accepted, appointmentId)
        );
        await waitUntil(
          "both reschedule notifications",
          () => recorded.emailDispatches.length > 2
        );
      });
      await save("case-appointment-replacement", `case/${caseId}`);
    })();

    // The two recovery reschedules `docs/case-lifecycle.md` names separately
    // from the proactive one. Both skip the `previousStartTime` gate the
    // proactive path enforces, so each is its own branch of the handler.
    for (const previous of ["NO_ACCESS", "MISSED"] as const) {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        const { accepted, appointmentId } = await acceptedCase(
          recorded,
          taskQueue,
          caseId,
          // NO_ACCESS is reported inside the window; MISSED needs the window
          // to close unattended, so the Appointment ends almost immediately.
          previous === "NO_ACCESS"
            ? { start: -1_000, end: 5 * 60_000 }
            : { start: -1_000, end: 1_000 }
        );
        if (previous === "NO_ACCESS") {
          await updateOk(
            caseId,
            UPDATE_NAMES.reportNoAccess,
            noAccessCommand(accepted, appointmentId)
          );
        } else {
          // The expiry Saga clears `missedAppointmentRecovery` before it
          // raises this, so the replacement below never races it.
          await waitUntil("the missed-Appointment Attention", () =>
            recorded.attentions.includes("MISSED_APPOINTMENT")
          );
        }
        const before = recorded.emailDispatches.length;
        await updateOk(
          caseId,
          UPDATE_NAMES.replaceAppointment,
          replaceCommand(accepted, appointmentId, previous)
        );
        await waitUntil(
          "both reschedule notifications",
          () => recorded.emailDispatches.length > before + 1
        );
      });
      await save(
        `case-appointment-replacement-after-${previous.toLowerCase().replace("_", "-")}`,
        `case/${caseId}`
      );
    }

    // An Appointment whose window closes unattended: the expiry timer fires.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        await acceptedCase(recorded, taskQueue, caseId, {
          start: -1_000,
          end: 1_000,
        });
        await waitUntil("the missed-Appointment Attention", () =>
          recorded.attentions.includes("MISSED_APPOINTMENT")
        );
      });
      await save("case-missed-appointment", `case/${caseId}`);
    })();

    // Cancellation of a Case with a live scheduled Appointment; runs to
    // closure once the cancellation chain commits.
    await (async () => {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(makeActivities({ recorded }), async (taskQueue) => {
        await acceptedCase(recorded, taskQueue, caseId, {
          start: 5 * 60_000,
          end: 6 * 60_000,
        });
        await updateOk(caseId, UPDATE_NAMES.cancelCase, cancelCommand(caseId));
        await client.workflow.getHandle(`case/${caseId}`).result();
      });
      await save("case-cancellation", `case/${caseId}`);
    })();

    // Derived-effect repair. The assignment notification fails its first
    // delivery in both branches; one is retried by an Officer and then
    // succeeds, the other is waived while still failing.
    for (const repair of ["retry", "waive"] as const) {
      const caseId = randomUUID();
      const recorded = newRecorder();
      await withWorker(
        makeActivities({
          recorded,
          onEmailDispatch: async () => {
            if (repair === "retry" && recorded.emailDispatches.length > 1) {
              return;
            }
            throw new Error("email delivery failed");
          },
        }),
        async (taskQueue) => {
          await updateWithStart(
            taskQueue,
            caseId,
            UPDATE_NAMES.openCase,
            openCommand()
          );
          await waitUntil(
            "the failed delivery",
            () => recorded.emailDispatches.length > 0
          );
          const [attempt] = recorded.attempts;
          if (!attempt) throw new Error("No Attempt was committed");
          const effectId = `${attempt.id}/assignment-notification`;
          if (repair === "retry") {
            await updateOk(
              caseId,
              UPDATE_NAMES.retryEffect,
              retryCommand(caseId, effectId)
            );
            await waitUntil(
              "the redelivery",
              () => recorded.emailDispatches.length > 1
            );
          } else {
            // updateOk, not update: a waive for an unknown effect ID returns
            // EFFECT_NOT_FOUND before scheduling any Activity, and nothing
            // downstream here would notice — the fixture would just quietly
            // stop being of the waive branch.
            await updateOk(
              caseId,
              UPDATE_NAMES.waiveEffect,
              waiveCommand(caseId, effectId)
            );
          }
        }
      );
      await save(`case-effect-repair-${repair}`, `case/${caseId}`);
    }

    // Continue-As-New. Reproduces `continue-as-new.test.ts`'s first test: the
    // acceptance deadline is armed but not yet due, history is grown past the
    // threshold by no-op Updates, and a failing delivery arms the retry timer
    // that wakes the loop into the gate. Both runs are saved — the first
    // carries the patch marker and the ContinueAsNew command, the second the
    // carry-over restore path.
    await (async () => {
      const caseId = randomUUID();
      const workflowId = `case/${caseId}`;
      const recorded = newRecorder();
      const dispatchGate = deferred<void>();
      let firstRunId = "";
      let secondRunId = "";
      await withWorker(
        makeActivities({
          recorded,
          deadlineOffsetMs: 10_000,
          onEmailDispatch: async () => {
            if (recorded.emailDispatches.length > 1) return;
            await dispatchGate.promise;
            throw new Error("email delivery failed");
          },
        }),
        async (taskQueue) => {
          await updateWithStart(
            taskQueue,
            caseId,
            UPDATE_NAMES.openCase,
            openCommand(),
            CONTINUE_AS_NEW_AFTER_EVENTS
          );
          await waitUntil(
            "the first delivery attempt",
            () =>
              recorded.attempts.length > 0 &&
              recorded.emailDispatches.length > 0
          );
          firstRunId = await runIdOf(workflowId);
          await growHistory(caseId);

          dispatchGate.resolve();
          secondRunId = await waitForNewRun(workflowId, firstRunId);
          await waitUntil(
            "the new run's redelivery",
            () => recorded.emailDispatches.length > 1
          );
        }
      );
      await save("case-continue-as-new-first-run", workflowId, firstRunId);
      await save("case-continue-as-new-second-run", workflowId, secondRunId);
    })();

    // The other two carried timers, which the pair above never arms. Mirrors
    // `continue-as-new.test.ts`'s fourth test: one Case accepts (its only
    // deadline is the Appointment's end) and one breaches with no replacement
    // candidate (its only deadline is the automatic allocation retry). Only
    // the new runs are saved — those are the histories that go red if either
    // timer stops being restored. Each assignment notification is held in
    // flight, so nothing can continue as new mid-delivery, and then *sent*, so
    // no effect retry deadline stands in for the carried timer.
    await (async () => {
      const cases = { appointment: randomUUID(), retry: randomUUID() };
      const recorded = newRecorder();
      const dispatchGate = deferred<void>();
      const secondRuns: Record<string, string> = {};
      await withWorker(
        makeActivities({
          recorded,
          deadlineOffsetMs: 4_000,
          onEmailDispatch: async (id) => {
            if (id.endsWith("/assignment-notification")) {
              await dispatchGate.promise;
            }
          },
        }),
        async (taskQueue) => {
          for (const caseId of Object.values(cases)) {
            await updateWithStart(
              taskQueue,
              caseId,
              UPDATE_NAMES.openCase,
              openCommand(),
              CONTINUE_AS_NEW_AFTER_EVENTS
            );
          }
          await waitUntil("both Attempts", () => recorded.attempts.length >= 2);
          // `runAllocation` builds `${caseId}/allocate/...`, so the operation
          // ID is what tells the two Cases' Attempts apart in one recorder.
          const attempt = recorded.attempts.find((candidate) =>
            candidate.operationId.startsWith(cases.appointment)
          );
          if (!attempt) throw new Error("No Attempt for the accepted Case");
          await updateOk(
            cases.appointment,
            UPDATE_NAMES.acceptAllocation,
            acceptCommand(cases.appointment, attempt, 30 * 60_000, 60 * 60_000)
          );

          await growHistory(cases.appointment);
          await growHistory(cases.retry);
          // The other Case's Attempt breaches with no candidate left, which
          // arms `automaticRetryAt` and leaves automatic allocation idle.
          await waitUntil("the breach Attention", () =>
            recorded.attentions.includes("NO_ELIGIBLE_CONTRACTOR")
          );

          const firstRuns = new Map<string, string>();
          for (const [name, caseId] of Object.entries(cases)) {
            firstRuns.set(name, await runIdOf(`case/${caseId}`));
          }
          dispatchGate.resolve();
          for (const [name, caseId] of Object.entries(cases)) {
            secondRuns[name] = await waitForNewRun(
              `case/${caseId}`,
              firstRuns.get(name) ?? ""
            );
          }
        }
      );
      for (const [name, caseId] of Object.entries(cases)) {
        await save(
          `case-continue-as-new-carried-${name}-timer`,
          `case/${caseId}`,
          secondRuns[name]
        );
      }
    })();

    // Resident provisioning: a different Workflow type on the same replay
    // bundle.
    await (async () => {
      const accountId = randomUUID();
      const workflowId = residentProvisioningWorkflowId(accountId);
      const command: ProvisionResidentInput = {
        accountId,
        fullName: "Rae Resident",
        email: "rae@example.com",
      };
      await withWorker(
        makeActivities({ recorded: newRecorder() }),
        async (taskQueue) => {
          await client.workflow
            .start(WORKFLOW_NAMES.residentProvisioning, {
              workflowId,
              taskQueue,
              args: [command],
            })
            .then((handle) => handle.result());
        },
        residentWorkflowsPath
      );
      await save("resident-provisioning", workflowId);
    })();
  } finally {
    await env.teardown();
  }

  let total = 0;
  for (const { name, events, bytes } of written) {
    total += bytes;
    console.log(`${name}: ${events} events, ${(bytes / 1024).toFixed(1)} KiB`);
  }
  console.log(`${written.length} histories, ${(total / 1024).toFixed(1)} KiB`);
}

await main();

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
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  ManualAllocationCommand,
  OpenCaseCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { immediateDerivedEffectActivities } from "./derived-effect-test-activities";

const postalCode = "123456";

/** Polls a closure-mutated counter; a bare `while` loop reads as a dead loop. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function openCommand(): OpenCaseCommand {
  const idempotencyKey = randomUUID();
  return {
    idempotencyKey,
    payloadHash: "a".repeat(64),
    operationId: `${idempotencyKey}.${"a".repeat(64)}`,
    actorId: randomUUID(),
    actorRole: "OFFICER",
    input: {
      residentId: randomUUID(),
      category: "LE",
      priority: "HIGH",
      description: "Broken street light",
      postalCode,
    },
  };
}

function createdCase(input: CreateCaseActivityInput): CaseDto {
  return {
    id: input.caseId,
    residentId: input.input.residentId,
    category: input.input.category,
    priority: input.input.priority,
    status: "PENDING",
    description: input.input.description,
    addressDetails: null,
    postalCode: input.input.postalCode,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("Manual allocation", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("processes an Officer allocation while automatic polling is waiting", async () => {
    const caseId = randomUUID();
    const contractorId = "11111111-1111-4111-8111-111111111111";
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const commits: CommitAllocationInput[] = [];
    let snapshots = 0;
    let terminal = false;

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        isCaseTerminal: async () => terminal,
        openCase: async (input: CreateCaseActivityInput) => createdCase(input),
        fetchAllocationSnapshot: async () => {
          snapshots += 1;
          return snapshots === 1
            ? { epoch: 0, candidates: [] }
            : {
                epoch: 0,
                candidates: [
                  {
                    contractorId,
                    activeAssignments: 0,
                    totalScore: 0,
                  },
                ],
              };
        },
        commitAllocationAttempt: async (input: CommitAllocationInput) => {
          commits.push(input);
          return {
            outcome: "COMMITTED",
            assignment: {
              id: randomUUID(),
              caseId: input.caseId,
              createdAt: "2026-07-22T00:00:00.000Z",
              updatedAt: "2026-07-22T00:00:00.000Z",
            },
            attempt: {
              id: randomUUID(),
              assignmentId: randomUUID(),
              contractorId: input.contractorId,
              source: input.source,
              status: "PENDING_ACCEPTANCE",
              acceptanceSlaMs: input.acceptanceSlaMs,
              deadlineAt: new Date(Date.now() + 60_000).toISOString(),
              actorId: input.actorId,
              actorRole: input.actorRole,
              reason: input.reason ?? null,
              operationId: input.operationId,
              createdAt: "2026-07-22T00:00:00.000Z",
            },
            epoch: 1,
          } satisfies CommitAllocationResult;
        },
        markCaseAssigned: async () => "ASSIGNED" as const,
        raiseOfficerAttention: async () => undefined,
        ...immediateDerivedEffectActivities(),
      },
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      await client.workflow.executeUpdateWithStart(UPDATE_NAMES.openCase, {
        args: [openCommand()],
        updateId: randomUUID(),
        startWorkflowOperation: new WithStartWorkflowOperation(
          WORKFLOW_NAMES.case,
          {
            workflowId: `case/${caseId}`,
            taskQueue,
            args: [{ caseId }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          }
        ),
      });

      await waitUntil(() => snapshots > 0);
      expect(snapshots).toBeGreaterThan(0);

      terminal = true;
      const terminalIdempotencyKey = randomUUID();
      const terminalResult = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [
            {
              idempotencyKey: terminalIdempotencyKey,
              payloadHash: "c".repeat(64),
              operationId: `${terminalIdempotencyKey}.${"c".repeat(64)}`,
              actorId: randomUUID(),
              actorRole: "OFFICER",
              caseId,
              category: "LE",
              postalCode,
              input: { contractorId },
            },
          ],
          updateId: randomUUID(),
        });
      expect(terminalResult).toEqual({ kind: "CASE_TERMINAL" });
      expect(snapshots).toBe(1);
      expect(commits).toHaveLength(0);

      terminal = false;
      const idempotencyKey = randomUUID();
      const command: ManualAllocationCommand = {
        idempotencyKey,
        payloadHash: "b".repeat(64),
        operationId: `${idempotencyKey}.${"b".repeat(64)}`,
        actorId: randomUUID(),
        actorRole: "OFFICER",
        caseId,
        category: "LE",
        postalCode,
        input: { contractorId },
      };

      const result = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [command],
          updateId: randomUUID(),
        });
      const replay = await client.workflow
        .getHandle(`case/${caseId}`)
        .executeUpdate(UPDATE_NAMES.allocateContractor, {
          args: [command],
          updateId: randomUUID(),
        });

      expect(result).toMatchObject({ kind: "SUCCESS" });
      expect(replay).toEqual(result);
      expect(commits).toContainEqual(
        expect.objectContaining({
          contractorId,
          source: "MANUAL_ASSIGN",
        })
      );
      expect(
        commits.filter((commit) => commit.source === "MANUAL_ASSIGN")
      ).toHaveLength(1);
      await client.workflow.getHandle(`case/${caseId}`).terminate();
    });
  }, 30_000);
});

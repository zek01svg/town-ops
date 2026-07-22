import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/activity";
import {
  Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  ORCHESTRATION_TASK_QUEUE,
  WORKFLOW_NAMES,
} from "@townops/orchestration-contract";
import type {
  AllocationCandidate,
  AllocationSnapshot,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  OpenCaseCommand,
} from "@townops/orchestration-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Automatic allocation is only observable through what the Workflow commits —
 * its ranking function is deliberately private. Every test here therefore
 * asserts which Contractor was actually offered the Case, which is the
 * externally visible consequence of the ranking rules.
 */

const postalCode = "123456";

function candidate(
  contractorId: string,
  activeAssignments: number,
  totalScore: number
): AllocationCandidate {
  return { contractorId, activeAssignments, totalScore };
}

function command(): OpenCaseCommand {
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

type Collected = {
  commits: CommitAllocationInput[];
  assigned: string[];
  snapshotsFetched: number;
};

type Harness = {
  snapshots: AllocationSnapshot[];
  commit?: (input: CommitAllocationInput) => Promise<CommitAllocationResult>;
  /**
   * What this test is waiting for. Allocation runs after the Update returns,
   * so each test must name its own settling condition rather than share a
   * guessed one.
   */
  until: (collected: Collected) => boolean;
};

/**
 * Opens one Case and lets the Workflow's allocation loop run to quiescence.
 * Returns every commit the Workflow attempted, in order.
 */
async function openCaseAndAllocate(
  env: TestWorkflowEnvironment,
  { snapshots, commit, until }: Harness
) {
  const commits: CommitAllocationInput[] = [];
  const assigned: string[] = [];
  const caseId = randomUUID();
  const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
  let snapshotIndex = 0;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("../src/workflows/case-workflow.ts", import.meta.url)
    ),
    activities: {
      openCase: async (input: CreateCaseActivityInput) => createdCase(input),
      fetchAllocationSnapshot: async (): Promise<AllocationSnapshot> => {
        const snapshot =
          snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return snapshot;
      },
      commitAllocationAttempt: async (
        input: CommitAllocationInput
      ): Promise<CommitAllocationResult> => {
        commits.push(input);
        if (commit) return commit(input);
        return {
          outcome: "COMMITTED",
          attempt: {
            id: randomUUID(),
            contractorId: input.contractorId,
            status: "PENDING_ACCEPTANCE",
          },
          epoch: input.expectedEpoch + 1,
        } as CommitAllocationResult;
      },
      markCaseAssigned: async (input: { caseId: string }) => {
        assigned.push(input.caseId);
      },
    },
  });

  const client = new Client({ connection: env.nativeConnection });
  const workflowId = `case/${caseId}`;

  await worker.runUntil(async () => {
    await client.workflow.executeUpdateWithStart("openCase", {
      args: [command()],
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

    // The Update returns as soon as the Case exists; allocation runs after it
    // on the main body, so wait for this test's observable effect.
    const deadline = Date.now() + 10_000;
    while (
      !until({ commits, assigned, snapshotsFetched: snapshotIndex }) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await client.workflow.getHandle(workflowId).terminate();
  });

  return {
    commits,
    assigned,
    caseId,
    snapshotsFetched: snapshotIndex,
    // False when the wait gave up. Without this a test asserting only on empty
    // arrays cannot tell "allocation correctly did nothing" from "allocation
    // never ran at all".
    settled: until({ commits, assigned, snapshotsFetched: snapshotIndex }),
  };
}

describe("Automatic allocation ranking", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("prefers the Contractor with the fewest active Assignments", async () => {
    const busy = "11111111-1111-4111-8111-111111111111";
    const free = "22222222-2222-4222-8222-222222222222";
    const { commits } = await openCaseAndAllocate(env, {
      // `busy` sorts first by ID and ties on score, so only the active-
      // Assignment rule can explain choosing `free`.
      snapshots: [
        {
          epoch: 0,
          candidates: [candidate(busy, 5, 0), candidate(free, 1, 0)],
        },
      ],
      until: ({ assigned }) => assigned.length > 0,
    });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.contractorId).toBe(free);
  }, 30_000);

  it("breaks a tie on active Assignments with the highest performance score", async () => {
    const lowScore = "11111111-1111-4111-8111-111111111111";
    const highScore = "22222222-2222-4222-8222-222222222222";
    const { commits } = await openCaseAndAllocate(env, {
      // Equal workload and `lowScore` sorts first by ID, so only the score
      // rule can explain choosing `highScore`.
      snapshots: [
        {
          epoch: 0,
          candidates: [candidate(lowScore, 2, 10), candidate(highScore, 2, 40)],
        },
      ],
      until: ({ assigned }) => assigned.length > 0,
    });

    expect(commits[0]?.contractorId).toBe(highScore);
  }, 30_000);

  it("breaks a full tie with the lowest Contractor ID", async () => {
    const lower = "11111111-1111-4111-8111-111111111111";
    const higher = "99999999-9999-4999-8999-999999999999";
    const { commits } = await openCaseAndAllocate(env, {
      // Identical on every earlier key, and offered highest-first, so only the
      // ID rule can explain choosing `lower`.
      snapshots: [
        {
          epoch: 0,
          candidates: [candidate(higher, 2, 10), candidate(lower, 2, 10)],
        },
      ],
      until: ({ assigned }) => assigned.length > 0,
    });

    expect(commits[0]?.contractorId).toBe(lower);
  }, 30_000);
});

describe("Automatic allocation outcomes", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("commits nothing and leaves the Case unassigned when no Contractor is eligible", async () => {
    const { commits, assigned, snapshotsFetched, settled } =
      await openCaseAndAllocate(env, {
        snapshots: [{ epoch: 0, candidates: [] }],
        // Nothing will ever be committed, so settle on the pass having run.
        until: ({ snapshotsFetched }) => snapshotsFetched > 0,
      });

    // Prove allocation actually ran before asserting it committed nothing,
    // otherwise a dead loop would satisfy the assertions below.
    expect(settled).toBe(true);
    expect(snapshotsFetched).toBeGreaterThan(0);
    expect(commits).toHaveLength(0);
    expect(assigned).toHaveLength(0);
  }, 30_000);

  it("marks the Case assigned once a Contractor is committed", async () => {
    const contractorId = "11111111-1111-4111-8111-111111111111";
    const { commits, assigned, caseId } = await openCaseAndAllocate(env, {
      snapshots: [{ epoch: 0, candidates: [candidate(contractorId, 0, 0)] }],
      until: ({ assigned }) => assigned.length > 0,
    });

    expect(commits[0]?.contractorId).toBe(contractorId);
    expect(commits[0]?.source).toBe("AUTO_ASSIGN");
    expect(assigned).toEqual([caseId]);
  }, 30_000);

  it("refetches and reranks against a fresh snapshot after a stale epoch", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    let calls = 0;

    const { commits, assigned } = await openCaseAndAllocate(env, {
      snapshots: [
        { epoch: 0, candidates: [candidate(first, 0, 0)] },
        // The epoch moved and `first` is now busy, so a correct rerank must
        // switch Contractors rather than blindly retrying the old choice.
        {
          epoch: 7,
          candidates: [candidate(first, 9, 0), candidate(second, 0, 0)],
        },
      ],
      until: ({ assigned }) => assigned.length > 0,
      commit: async (input) => {
        calls += 1;
        if (calls === 1) return { outcome: "STALE_EPOCH", epoch: 7 };
        return {
          outcome: "COMMITTED",
          attempt: {
            id: randomUUID(),
            contractorId: input.contractorId,
            status: "PENDING_ACCEPTANCE",
          },
          epoch: input.expectedEpoch + 1,
        } as CommitAllocationResult;
      },
    });

    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ contractorId: first, expectedEpoch: 0 });
    expect(commits[1]).toMatchObject({
      contractorId: second,
      expectedEpoch: 7,
    });
    expect(assigned).toHaveLength(1);
  }, 30_000);

  it("survives a permanent allocation failure instead of failing the Workflow", async () => {
    // Regression guard: allocation used to be a floating promise whose
    // failures vanished. The Workflow must stay alive and still serve Updates.
    const contractorId = "11111111-1111-4111-8111-111111111111";
    const caseId = randomUUID();
    const taskQueue = `${ORCHESTRATION_TASK_QUEUE}-${randomUUID()}`;
    const workflowId = `case/${caseId}`;

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("../src/workflows/case-workflow.ts", import.meta.url)
      ),
      activities: {
        openCase: async (input: CreateCaseActivityInput) => createdCase(input),
        fetchAllocationSnapshot: async (): Promise<AllocationSnapshot> => ({
          epoch: 0,
          candidates: [candidate(contractorId, 0, 0)],
        }),
        commitAllocationAttempt: async () => {
          throw ApplicationFailure.nonRetryable(
            "assignment atom rejected the allocation",
            "ALLOCATION_REJECTED"
          );
        },
        markCaseAssigned: async () => undefined,
      },
    });
    const client = new Client({ connection: env.nativeConnection });

    await worker.runUntil(async () => {
      const start = (updateId: string) =>
        client.workflow.executeUpdateWithStart("openCase", {
          args: [command()],
          updateId,
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

      await start(randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The Workflow is still running and still accepting work, which it
      // could not do if the failed allocation had bubbled out of the loop.
      const description = await client.workflow
        .getHandle(workflowId)
        .describe();
      expect(description.status.name).toBe("RUNNING");

      const second = await start(randomUUID());
      expect(second).toMatchObject({ kind: "SUCCESS" });

      await client.workflow.getHandle(workflowId).terminate();
    });
  }, 30_000);
});

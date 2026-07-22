import {
  condition,
  defineUpdate,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import {
  DEFAULT_ACCEPTANCE_SLA_MS,
  ManualAllocationCommandSchema,
  OpenCaseCommandSchema,
  postalSector,
  UPDATE_NAMES,
} from "@townops/orchestration-contract";
import type {
  AllocationCandidate,
  AllocationSnapshot,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  ManualAllocationCommand,
  ManualAllocationResult,
  MarkCaseAssignedResult,
  OpenCaseCommand,
  OpenCaseResult,
} from "@townops/orchestration-contract";

export const openCase = defineUpdate<OpenCaseResult, [OpenCaseCommand]>(
  UPDATE_NAMES.openCase
);
export const allocateContractor = defineUpdate<
  ManualAllocationResult,
  [ManualAllocationCommand]
>(UPDATE_NAMES.allocateContractor);

const activities = proxyActivities<{
  isCaseTerminal(input: { caseId: string }): Promise<boolean>;
  openCase(input: CreateCaseActivityInput): Promise<CaseDto>;
  fetchAllocationSnapshot(input: {
    category: string;
    postalSector: string;
  }): Promise<AllocationSnapshot>;
  commitAllocationAttempt(
    input: CommitAllocationInput
  ): Promise<CommitAllocationResult>;
  markCaseAssigned(input: {
    caseId: string;
    operationId: string;
    actorId: string;
    actorRole: string;
  }): Promise<MarkCaseAssignedResult["outcome"]>;
  raiseOfficerAttention(input: {
    caseId: string;
    kind: "NO_ELIGIBLE_CONTRACTOR" | "ALLOCATION_FAILED";
    detail: string;
    operationId: string;
  }): Promise<unknown>;
}>({ startToCloseTimeout: "10 seconds" });

type Operation = {
  payloadHash: string;
  result?: OpenCaseResult;
  pending?: Promise<OpenCaseResult>;
};

type AutomaticAllocationRequest = {
  kind: "AUTOMATIC";
  category: string;
  postalCode: string;
};
type ManualAllocationRequest = {
  kind: "MANUAL";
  command: ManualAllocationCommand;
  complete: (result: ManualAllocationResult) => void;
};
type AllocationRequest = AutomaticAllocationRequest | ManualAllocationRequest;
type AllocationContext = { category: string; postalCode: string };

type ManualOperation = {
  payloadHash: string;
  result?: ManualAllocationResult;
  pending?: Promise<ManualAllocationResult>;
};

/**
 * Outcome of the last allocation pass. `NO_CANDIDATE` and `FAILED` both leave
 * the Case PENDING but for different reasons, and PRS-141 acts on each
 * differently — so they must stay distinguishable rather than collapsing into
 * one silent nothing.
 */
type AllocationState =
  | { status: "IDLE" }
  | { status: "ALLOCATED"; contractorId: string }
  | { status: "TERMINAL" }
  | { status: "NO_CANDIDATE" }
  | { status: "FAILED"; reason: string };

// Automatic allocation (PRS-139) acts on the Case's behalf, not a Resident
// or Officer — a fixed system identity keeps the actor fields non-null.
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
const SYSTEM_ACTOR_ROLE = "SYSTEM";
const MAX_ALLOCATION_ROUNDS = 5;
const INITIAL_ALLOCATION_RETRY_MS = 60_000;
const MAX_ALLOCATION_RETRY_MS = 60 * 60_000;

/**
 * Fewest active Assignments, then highest total score, then Contractor ID
 * ascending (plain string compare — locale-aware compare is not guaranteed
 * stable across replay). Excludes Contractors this Workflow already
 * attempted.
 */
function rankCandidates(
  candidates: AllocationCandidate[],
  excluded: Set<string>
) {
  return candidates
    .filter((candidate) => !excluded.has(candidate.contractorId))
    .toSorted((a, b) => {
      if (a.activeAssignments !== b.activeAssignments) {
        return a.activeAssignments - b.activeAssignments;
      }
      if (a.totalScore !== b.totalScore) {
        return b.totalScore - a.totalScore;
      }
      return a.contractorId < b.contractorId
        ? -1
        : a.contractorId > b.contractorId
          ? 1
          : 0;
    });
}

/**
 * Automatic Contractor allocation for a just-opened Case (PRS-139). Ranking
 * happens here, in the Workflow, so it stays deterministic and replayable —
 * the Activities above do I/O only.
 *
 * Returns the outcome rather than throwing it away, so a Case that could not
 * be allocated is distinguishable from one that never tried.
 */
async function runAllocation(
  caseId: string,
  category: string,
  postalCode: string,
  attemptedContractorIds: Set<string>
): Promise<AllocationState> {
  if (await activities.isCaseTerminal({ caseId })) {
    return { status: "TERMINAL" };
  }

  const sector = postalSector(postalCode);
  let snapshot = await activities.fetchAllocationSnapshot({
    category,
    postalSector: sector,
  });

  for (let round = 0; round < MAX_ALLOCATION_ROUNDS; round++) {
    const [candidate] = rankCandidates(
      snapshot.candidates,
      attemptedContractorIds
    );
    if (!candidate) {
      // No eligible Contractor was found. PRS-141 owns retry-polling and
      // Officer Attention for a Case stuck like this — leave it PENDING.
      return { status: "NO_CANDIDATE" };
    }

    const operationId = `${caseId}/allocate/${candidate.contractorId}/${snapshot.epoch}`;
    const result = await activities.commitAllocationAttempt({
      operationId,
      caseId,
      contractorId: candidate.contractorId,
      source: "AUTO_ASSIGN",
      expectedEpoch: snapshot.epoch,
      acceptanceSlaMs: DEFAULT_ACCEPTANCE_SLA_MS,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: SYSTEM_ACTOR_ROLE,
    });

    if (
      result.outcome === "COMMITTED" ||
      result.outcome === "ALREADY_COMMITTED"
    ) {
      attemptedContractorIds.add(candidate.contractorId);
      const assignmentOutcome = await activities.markCaseAssigned({
        caseId,
        operationId,
        actorId: SYSTEM_ACTOR_ID,
        actorRole: SYSTEM_ACTOR_ROLE,
      });
      if (assignmentOutcome === "CASE_TERMINAL") {
        return { status: "TERMINAL" };
      }
      return { status: "ALLOCATED", contractorId: candidate.contractorId };
    }

    if (result.outcome === "ACTIVE_ATTEMPT_EXISTS") {
      // Another allocation already won the race for this Case.
      return {
        status: "ALLOCATED",
        contractorId: result.attempt.contractorId,
      };
    }

    // STALE_EPOCH — the epoch moved under us; refetch and rerank.
    snapshot = await activities.fetchAllocationSnapshot({
      category,
      postalSector: sector,
    });
  }

  // Every round lost its epoch race. Treated as unresolved rather than
  // successful, so PRS-141's polling can pick the Case back up.
  return {
    status: "FAILED",
    reason: `allocation lost the epoch race ${MAX_ALLOCATION_ROUNDS} times`,
  };
}

async function runManualAllocation(
  command: ManualAllocationCommand,
  attemptedContractorIds: Set<string>
): Promise<ManualAllocationResult> {
  if (await activities.isCaseTerminal({ caseId: command.caseId })) {
    return { kind: "CASE_TERMINAL" };
  }

  const sector = postalSector(command.postalCode);
  let snapshot = await activities.fetchAllocationSnapshot({
    category: command.category,
    postalSector: sector,
  });

  for (let round = 0; round < MAX_ALLOCATION_ROUNDS; round++) {
    const candidate = snapshot.candidates.find(
      ({ contractorId }) => contractorId === command.input.contractorId
    );
    if (!candidate) return { kind: "CONTRACTOR_NOT_ELIGIBLE" };

    const result = await activities.commitAllocationAttempt({
      operationId: command.operationId,
      caseId: command.caseId,
      contractorId: candidate.contractorId,
      source: "MANUAL_ASSIGN",
      expectedEpoch: snapshot.epoch,
      acceptanceSlaMs: DEFAULT_ACCEPTANCE_SLA_MS,
      actorId: command.actorId,
      actorRole: command.actorRole,
      reason: command.input.reason,
      replaceAttemptId: command.input.replaceAttemptId,
    });

    if (
      result.outcome === "COMMITTED" ||
      result.outcome === "ALREADY_COMMITTED"
    ) {
      attemptedContractorIds.add(candidate.contractorId);
      const assignmentOutcome = await activities.markCaseAssigned({
        caseId: command.caseId,
        operationId: command.operationId,
        actorId: command.actorId,
        actorRole: command.actorRole,
      });
      if (assignmentOutcome === "CASE_TERMINAL") {
        return { kind: "CASE_TERMINAL" };
      }
      return {
        kind: "SUCCESS",
        data: { assignment: result.assignment, attempt: result.attempt },
      };
    }

    if (result.outcome === "ACTIVE_ATTEMPT_EXISTS") {
      return { kind: "ACTIVE_ATTEMPT_EXISTS" };
    }
    if (result.outcome === "REPLACEMENT_ATTEMPT_NOT_PENDING") {
      return { kind: "REPLACEMENT_ATTEMPT_NOT_PENDING" };
    }

    snapshot = await activities.fetchAllocationSnapshot({
      category: command.category,
      postalSector: sector,
    });
  }

  return {
    kind: "ALLOCATION_FAILED",
    reason: `manual allocation lost the epoch race ${MAX_ALLOCATION_ROUNDS} times`,
  };
}

async function raiseAllocationAttention(
  caseId: string,
  allocation: Extract<AllocationState, { status: "NO_CANDIDATE" | "FAILED" }>
) {
  const kind =
    allocation.status === "NO_CANDIDATE"
      ? "NO_ELIGIBLE_CONTRACTOR"
      : "ALLOCATION_FAILED";
  const detail =
    allocation.status === "NO_CANDIDATE"
      ? "No eligible Contractor covers this Case."
      : allocation.reason;

  await activities.raiseOfficerAttention({
    caseId,
    kind,
    detail,
    operationId: `${caseId}/attention/${kind}`,
  });
}

/**
 * Durable owner of the opening operation for one Case.
 *
 * The workflow remains open for later PRS-81 lifecycle updates. Its first
 * Update writes a Case through the Case atom exactly once per operation ID.
 */
export async function CaseWorkflow({ caseId }: { caseId: string }) {
  const operations = new Map<string, Operation>();
  const manualOperations = new Map<string, ManualOperation>();
  // In-Workflow only — never exposed as a Query/read model. Tracks which
  // Contractors this Workflow already committed or attempted, across
  // allocation passes for this Case's whole lifetime.
  const attemptedContractorIds = new Set<string>();
  const allocationQueue: AllocationRequest[] = [];
  let allocation: AllocationState = { status: "IDLE" };
  let automaticRetryAt: number | undefined;
  let automaticRetryDelayMs = INITIAL_ALLOCATION_RETRY_MS;
  let automaticAllocationActive = false;
  let allocationContext: AllocationContext | undefined;

  setHandler(openCase, async (unparsedCommand) => {
    const command = OpenCaseCommandSchema.parse(unparsedCommand);
    const existing = operations.get(command.idempotencyKey);

    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }

      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error("Open-case operation has no result or pending activity");
    }

    const operation: Operation = { payloadHash: command.payloadHash };
    operations.set(command.idempotencyKey, operation);
    operation.pending = activities
      .openCase({
        caseId,
        operationId: command.operationId,
        actorId: command.actorId,
        actorRole: command.actorRole,
        input: command.input,
      })
      .then((data) => ({ kind: "SUCCESS", data }));

    try {
      operation.result = await operation.pending;
    } catch (error) {
      operations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
    }

    const result = operation.result;
    if (!result) {
      throw new Error("Open-case operation completed without a result");
    }

    if (result.kind === "SUCCESS") {
      // Record the intent only. The main body below runs allocation, so this
      // handler never spawns an untracked promise and returns as soon as the
      // Case is durably created.
      allocationContext = {
        category: result.data.category,
        postalCode: result.data.postalCode,
      };
      allocationQueue.push({ kind: "AUTOMATIC", ...allocationContext });
    }

    return result;
  });

  setHandler(allocateContractor, async (unparsedCommand) => {
    const command = ManualAllocationCommandSchema.parse(unparsedCommand);
    if (command.caseId !== caseId) {
      return {
        kind: "ALLOCATION_FAILED",
        reason: "Manual allocation Case does not match this Workflow",
      };
    }
    allocationContext = {
      category: command.category,
      postalCode: command.postalCode,
    };

    const existing = manualOperations.get(command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error(
        "Manual allocation operation has no result or pending allocation"
      );
    }

    const operation: ManualOperation = { payloadHash: command.payloadHash };
    manualOperations.set(command.idempotencyKey, operation);
    operation.pending = new Promise<ManualAllocationResult>((resolve) => {
      allocationQueue.push({ kind: "MANUAL", command, complete: resolve });
    });

    operation.result = await operation.pending;
    delete operation.pending;
    return operation.result;
  });

  // Allocation runs here, never inside an Update handler. PRS-141 extends this
  // loop with a lossless intent queue. A timed automatic poll never blocks an
  // Officer Update: `condition` wakes as soon as the queue receives a manual
  // request, while the absolute retry deadline remains intact.
  while (true) {
    if (allocationQueue.length === 0) {
      if (automaticRetryAt !== undefined && !automaticAllocationActive) {
        const wokeForRequest = await condition(
          () => allocationQueue.length > 0,
          Math.max(0, automaticRetryAt - Date.now())
        );
        if (!wokeForRequest && allocationContext) {
          allocationQueue.push({
            kind: "AUTOMATIC",
            ...allocationContext,
          });
        }
      } else {
        await condition(() => allocationQueue.length > 0);
      }
    }

    const request = allocationQueue.shift();
    if (!request) continue;

    if (request.kind === "MANUAL") {
      let result: ManualAllocationResult;
      try {
        result = await runManualAllocation(
          request.command,
          attemptedContractorIds
        );
      } catch (error) {
        result = {
          kind: "ALLOCATION_FAILED",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      if (result.kind === "SUCCESS") {
        automaticAllocationActive = true;
        automaticRetryAt = undefined;
        automaticRetryDelayMs = INITIAL_ALLOCATION_RETRY_MS;
        allocation = {
          status: "ALLOCATED",
          contractorId: result.data.attempt.contractorId,
        };
      } else if (result.kind === "ACTIVE_ATTEMPT_EXISTS") {
        automaticAllocationActive = true;
        automaticRetryAt = undefined;
      } else if (result.kind === "CASE_TERMINAL") {
        automaticAllocationActive = true;
        automaticRetryAt = undefined;
      } else if (result.kind === "ALLOCATION_FAILED") {
        allocation = { status: "FAILED", reason: result.reason };
        await raiseAllocationAttention(caseId, allocation);
        if (automaticRetryAt === undefined) {
          automaticRetryAt = Date.now() + automaticRetryDelayMs;
          automaticRetryDelayMs = Math.min(
            automaticRetryDelayMs * 2,
            MAX_ALLOCATION_RETRY_MS
          );
        }
      }

      request.complete(result);
      continue;
    }

    if (automaticAllocationActive) continue;

    try {
      allocation = await runAllocation(
        caseId,
        request.category,
        request.postalCode,
        attemptedContractorIds
      );
    } catch (error) {
      // A permanent Activity failure leaves the Case PENDING with the reason
      // recorded. It must not fail the Workflow, which stays open to repair
      // the Case, and it must not vanish.
      allocation = {
        status: "FAILED",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (allocation.status === "ALLOCATED") {
      automaticAllocationActive = true;
      automaticRetryAt = undefined;
      automaticRetryDelayMs = INITIAL_ALLOCATION_RETRY_MS;
      continue;
    }
    if (allocation.status === "TERMINAL") {
      automaticAllocationActive = true;
      automaticRetryAt = undefined;
      continue;
    }
    if (allocation.status === "IDLE") continue;

    await raiseAllocationAttention(caseId, allocation);
    log.warn("Case was not allocated", { caseId, allocation });
    automaticRetryAt = Date.now() + automaticRetryDelayMs;
    automaticRetryDelayMs = Math.min(
      automaticRetryDelayMs * 2,
      MAX_ALLOCATION_RETRY_MS
    );
  }
}

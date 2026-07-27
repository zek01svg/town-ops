import {
  condition,
  defineUpdate,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import {
  ACCEPTANCE_SLA_BREACH_SCORE_DELTA,
  AcceptAllocationCommandSchema,
  DEFAULT_ACCEPTANCE_SLA_MS,
  ManualAllocationCommandSchema,
  OpenCaseCommandSchema,
  postalSector,
  ReplaceAppointmentCommandSchema,
  ReportNoAccessCommandSchema,
  StartWorkCommandSchema,
  UPDATE_NAMES,
} from "@townops/orchestration-contract";
import type {
  AcceptAllocationCommand,
  AcceptAllocationResult,
  AllocationAttemptDto,
  AllocationCandidate,
  AllocationSnapshot,
  BreachAllocationAttemptInput,
  BreachAllocationAttemptResult,
  CaseDto,
  CommitAllocationInput,
  CommitAllocationResult,
  CreateCaseActivityInput,
  ManualAllocationCommand,
  ManualAllocationResult,
  MarkAppointmentMissedInput,
  MarkAppointmentMissedResult,
  MarkAssignmentInProgressInput,
  MarkAssignmentInProgressResult,
  MarkCaseAppointmentReplacedInput,
  MarkCaseAppointmentReplacedResult,
  MarkCaseAssignedResult,
  MarkCaseBreachedInput,
  MarkCaseBreachedResult,
  MarkCaseInProgressInput,
  MarkCaseInProgressResult,
  MarkCaseNoAccessInput,
  MarkCaseNoAccessResult,
  OpenCaseCommand,
  OpenCaseResult,
  OfficerAttentionKind,
  PerformanceEntryDto,
  RecordPerformanceEntryInput,
  ReplaceAppointmentCommand,
  ReplaceAppointmentResult,
  ReplaceAppointmentSlotInput,
  ReplaceAppointmentSlotResult,
  ReportNoAccessAppointmentInput,
  ReportNoAccessAppointmentResult,
  ReportNoAccessCommand,
  ReportNoAccessResult,
  StartWorkAppointmentInput,
  StartWorkAppointmentResult,
  StartWorkCommand,
  StartWorkResult,
} from "@townops/orchestration-contract";

export const openCase = defineUpdate<OpenCaseResult, [OpenCaseCommand]>(
  UPDATE_NAMES.openCase
);
export const allocateContractor = defineUpdate<
  ManualAllocationResult,
  [ManualAllocationCommand]
>(UPDATE_NAMES.allocateContractor);
export const acceptAllocation = defineUpdate<
  AcceptAllocationResult,
  [AcceptAllocationCommand]
>(UPDATE_NAMES.acceptAllocation);
export const startWork = defineUpdate<StartWorkResult, [StartWorkCommand]>(
  UPDATE_NAMES.startWork
);
export const reportNoAccess = defineUpdate<
  ReportNoAccessResult,
  [ReportNoAccessCommand]
>(UPDATE_NAMES.reportNoAccess);
export const replaceAppointment = defineUpdate<
  ReplaceAppointmentResult,
  [ReplaceAppointmentCommand]
>(UPDATE_NAMES.replaceAppointment);

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
  acceptAllocation(
    input: AcceptAllocationCommand
  ): Promise<AcceptAllocationResult>;
  markCaseAssigned(input: {
    caseId: string;
    operationId: string;
    actorId: string;
    actorRole: string;
  }): Promise<MarkCaseAssignedResult["outcome"]>;
  raiseOfficerAttention(input: {
    caseId: string;
    kind: OfficerAttentionKind;
    detail: string;
    operationId: string;
  }): Promise<unknown>;
  breachAllocationAttempt(
    input: BreachAllocationAttemptInput
  ): Promise<BreachAllocationAttemptResult>;
  recordPerformanceEntry(
    input: RecordPerformanceEntryInput
  ): Promise<PerformanceEntryDto>;
  markCaseBreached(
    input: MarkCaseBreachedInput
  ): Promise<MarkCaseBreachedResult["outcome"]>;
  startWorkAppointment(
    input: StartWorkAppointmentInput
  ): Promise<StartWorkAppointmentResult>;
  markAssignmentInProgress(
    input: MarkAssignmentInProgressInput
  ): Promise<MarkAssignmentInProgressResult>;
  markCaseInProgress(
    input: MarkCaseInProgressInput
  ): Promise<MarkCaseInProgressResult>;
  reportNoAccessAppointment(
    input: ReportNoAccessAppointmentInput
  ): Promise<ReportNoAccessAppointmentResult>;
  markAppointmentMissed(
    input: MarkAppointmentMissedInput
  ): Promise<MarkAppointmentMissedResult>;
  markCaseNoAccess(
    input: MarkCaseNoAccessInput
  ): Promise<MarkCaseNoAccessResult>;
  replaceAppointmentSlot(
    input: ReplaceAppointmentSlotInput
  ): Promise<ReplaceAppointmentSlotResult>;
  markCaseAppointmentReplaced(
    input: MarkCaseAppointmentReplacedInput
  ): Promise<MarkCaseAppointmentReplacedResult>;
}>({ startToCloseTimeout: "10 seconds" });

type Operation = {
  payloadHash: string;
  result?: OpenCaseResult;
  pending?: Promise<OpenCaseResult>;
};

/**
 * A committed Attempt the Workflow is currently tracking, with its deadline
 * pre-resolved to epoch ms so the main loop can arm a timer on it without
 * re-parsing a string every iteration.
 */
type CommittedAttempt = {
  attemptId: string;
  assignmentId: string;
  contractorId: string;
  deadlineAt: number;
};

/** The currently scheduled Appointment whose end timer this Workflow owns. */
type CurrentAppointment = {
  appointmentId: string;
  endAt: number;
};

type AutomaticAllocationRequest = {
  kind: "AUTOMATIC";
  // AUTO_ASSIGN for a Case's first allocation pass, BREACH_REASSIGN for a
  // replacement after PRS-144's acceptance SLA breach — carried through to
  // commitAllocationAttempt purely for the Attempt's audit trail.
  source: "AUTO_ASSIGN" | "BREACH_REASSIGN";
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
type AcceptanceOperation = {
  payloadHash: string;
  result?: AcceptAllocationResult;
  pending?: Promise<AcceptAllocationResult>;
};
type StartWorkOperation = {
  payloadHash: string;
  result?: StartWorkResult;
  pending?: Promise<StartWorkResult>;
};
type NoAccessOperation = {
  payloadHash: string;
  result?: ReportNoAccessResult;
  pending?: Promise<ReportNoAccessResult>;
};
type ReplaceAppointmentOperation = {
  payloadHash: string;
  result?: ReplaceAppointmentResult;
  pending?: Promise<ReplaceAppointmentResult>;
};

/**
 * The public ManualAllocationResult carries no Attempt payload on every
 * outcome (ACTIVE_ATTEMPT_EXISTS in particular). This internal wrapper
 * carries the committed Attempt alongside it, purely so the caller can arm
 * the breach timer, without widening the contract type callers depend on.
 */
type ManualAllocationOutcome = {
  result: ManualAllocationResult;
  attempt?: CommittedAttempt;
};

/**
 * Outcome of the last allocation pass. `NO_CANDIDATE` and `FAILED` both leave
 * the Case PENDING but for different reasons, and PRS-141 acts on each
 * differently — so they must stay distinguishable rather than collapsing into
 * one silent nothing.
 */
type AllocationState =
  | { status: "IDLE" }
  | { status: "ALLOCATED"; attempt: CommittedAttempt }
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

/** Resolves an Attempt DTO's ISO deadline to epoch ms once, at commit time. */
function toCommittedAttempt(attempt: AllocationAttemptDto): CommittedAttempt {
  return {
    attemptId: attempt.id,
    assignmentId: attempt.assignmentId,
    contractorId: attempt.contractorId,
    deadlineAt: Date.parse(attempt.deadlineAt),
  };
}

/**
 * Automatic Contractor allocation for a just-opened Case (PRS-139), or for a
 * breach replacement (PRS-144, source "BREACH_REASSIGN"). Ranking happens
 * here, in the Workflow, so it stays deterministic and replayable — the
 * Activities above do I/O only.
 *
 * Returns the outcome rather than throwing it away, so a Case that could not
 * be allocated is distinguishable from one that never tried.
 */
async function runAllocation(
  caseId: string,
  source: "AUTO_ASSIGN" | "BREACH_REASSIGN",
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
      source,
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
      return {
        status: "ALLOCATED",
        attempt: toCommittedAttempt(result.attempt),
      };
    }

    if (result.outcome === "ACTIVE_ATTEMPT_EXISTS") {
      // Another allocation already won the race for this Case. Arm on its
      // Attempt regardless — it is this same Workflow's own outstanding
      // offer, and the breach timer must track whichever Attempt is live.
      return {
        status: "ALLOCATED",
        attempt: toCommittedAttempt(result.attempt),
      };
    }

    // STALE_EPOCH — the epoch moved under us; refetch and rerank.
    // (OVERRIDE_REASON_REQUIRED cannot occur here: automatic allocation
    // never sends source "MANUAL_ASSIGN".)
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
): Promise<ManualAllocationOutcome> {
  if (await activities.isCaseTerminal({ caseId: command.caseId })) {
    return { result: { kind: "CASE_TERMINAL" } };
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
    if (!candidate) return { result: { kind: "CONTRACTOR_NOT_ELIGIBLE" } };

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
        return { result: { kind: "CASE_TERMINAL" } };
      }
      return {
        result: {
          kind: "SUCCESS",
          data: { assignment: result.assignment, attempt: result.attempt },
        },
        attempt: toCommittedAttempt(result.attempt),
      };
    }

    if (result.outcome === "ACTIVE_ATTEMPT_EXISTS") {
      return { result: { kind: "ACTIVE_ATTEMPT_EXISTS" } };
    }
    if (result.outcome === "REPLACEMENT_ATTEMPT_NOT_PENDING") {
      return { result: { kind: "REPLACEMENT_ATTEMPT_NOT_PENDING" } };
    }
    if (result.outcome === "OVERRIDE_REASON_REQUIRED") {
      // AC6: reusing a Contractor who already breached on this Assignment,
      // without a reason. A manual allocation is the only source that can
      // hit this — automatic allocation never sends a reason-less override.
      return { result: { kind: "OVERRIDE_REASON_REQUIRED" } };
    }

    snapshot = await activities.fetchAllocationSnapshot({
      category: command.category,
      postalSector: sector,
    });
  }

  return {
    result: {
      kind: "ALLOCATION_FAILED",
      reason: `manual allocation lost the epoch race ${MAX_ALLOCATION_ROUNDS} times`,
    },
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

type BreachOutcome =
  | { status: "REPLACED" }
  | { status: "CASE_TERMINAL" }
  | { status: "ATTEMPT_NO_LONGER_LIVE" };

/**
 * The acceptance SLA breach sequence (PRS-144): breach the Attempt, apply
 * the -10 penalty, return the Case to PENDING, and report what happened so
 * the caller can re-arm Workflow state and requeue a replacement. Kept as a
 * pure request/response function, like runAllocation above, rather than
 * closing over the Workflow's mutable state directly.
 *
 * Both `BREACHED` and `ALREADY_BREACHED` from the Activity proceed to the
 * penalty — a replay or a duplicate timer delivery must not silently drop
 * it. Only `ACCEPTED`/`WITHDRAWN` mean the offer is no longer live.
 */
async function runBreach(
  caseId: string,
  attempt: CommittedAttempt
): Promise<BreachOutcome> {
  const breach = await activities.breachAllocationAttempt({
    operationId: `${caseId}/breach/${attempt.attemptId}`,
    attemptId: attempt.attemptId,
    assignmentId: attempt.assignmentId,
    actorId: SYSTEM_ACTOR_ID,
    actorRole: SYSTEM_ACTOR_ROLE,
  });

  if (breach.outcome === "ACCEPTED" || breach.outcome === "WITHDRAWN") {
    return { status: "ATTEMPT_NO_LONGER_LIVE" };
  }

  await activities.recordPerformanceEntry({
    effectId: `${attempt.attemptId}/acceptance-sla-breach`,
    contractorId: attempt.contractorId,
    scoreDelta: ACCEPTANCE_SLA_BREACH_SCORE_DELTA,
    reason: "ACCEPTANCE_SLA_BREACH",
  });

  const caseOutcome = await activities.markCaseBreached({
    caseId,
    operationId: `${caseId}/breach/${attempt.attemptId}/pending`,
    attemptId: attempt.attemptId,
    actorId: SYSTEM_ACTOR_ID,
    actorRole: SYSTEM_ACTOR_ROLE,
    detail: `Contractor ${attempt.contractorId} did not accept before the acceptance SLA deadline.`,
  });

  return caseOutcome === "CASE_TERMINAL"
    ? { status: "CASE_TERMINAL" }
    : { status: "REPLACED" };
}

/**
 * The start-work Saga (PRS-145), forward-only: Appointment SCHEDULED ->
 * IN_PROGRESS, then Assignment ACCEPTED -> IN_PROGRESS, then Case ->
 * in_progress, one deterministic operation ID fanned out to each atom.
 *
 * A step-1 rejection (NOT_SCHEDULED / WRONG_CONTRACTOR / the Appointment not
 * found) means nothing was mutated anywhere — a clean, stable domain
 * response. A step-2 or step-3 rejection happens only *after* the
 * Appointment already committed: that is an invariant break, not a clean
 * rejection, so it raises Officer Attention and never rolls the Appointment
 * back (AC4 — no compensation, start-work is forward-only).
 */
async function runStartWork(
  command: StartWorkCommand
): Promise<StartWorkResult> {
  const op = command.operationId;

  const appointmentResult = await activities.startWorkAppointment({
    operationId: `${op}/appointment`,
    appointmentId: command.appointmentId,
    contractorId: command.contractorId,
  });
  if (appointmentResult.outcome === "APPOINTMENT_NOT_FOUND") {
    return { kind: "APPOINTMENT_MISMATCH" };
  }
  if (appointmentResult.outcome === "NOT_SCHEDULED") {
    return { kind: "NOT_SCHEDULED" };
  }
  if (appointmentResult.outcome === "WRONG_CONTRACTOR") {
    return { kind: "WRONG_CONTRACTOR" };
  }
  const appointment = appointmentResult.appointment;

  const assignmentResult = await activities.markAssignmentInProgress({
    operationId: `${op}/assignment`,
    assignmentId: command.assignmentId,
    changedBy: command.actorId,
  });
  if (
    assignmentResult.outcome !== "IN_PROGRESS" &&
    assignmentResult.outcome !== "ALREADY_IN_PROGRESS"
  ) {
    await activities.raiseOfficerAttention({
      caseId: command.caseId,
      kind: "WORK_START_FAILED",
      detail: `Assignment could not start work (${assignmentResult.outcome}) after the Appointment already started.`,
      operationId: `${op}/work-start-failed`,
    });
    return { kind: "WORK_START_FAILED" };
  }
  const assignment = assignmentResult.assignment;

  const caseResult = await activities.markCaseInProgress({
    caseId: command.caseId,
    operationId: `${op}/case`,
    actorId: command.actorId,
    actorRole: command.actorRole,
  });
  if (caseResult.outcome !== "IN_PROGRESS") {
    await activities.raiseOfficerAttention({
      caseId: command.caseId,
      kind: "WORK_START_FAILED",
      detail: `Case could not start work (${caseResult.outcome}) after the Appointment and Assignment already started.`,
      operationId: `${op}/work-start-failed`,
    });
    return { kind: "WORK_START_FAILED" };
  }

  return {
    kind: "SUCCESS",
    data: { appointment, assignment, case: caseResult.case },
  };
}

/**
 * The No-Access Saga (PRS-146 AC1), forward-only: Appointment SCHEDULED ->
 * NO_ACCESS, then the Case parked on the Resident.
 *
 * Unlike start-work there is no Officer Attention branch here: the Case write
 * is total — it either succeeds or reports CASE_TERMINAL, which is a clean
 * domain answer, never a half-applied state needing repair. The Assignment is
 * deliberately untouched; the Contractor keeps the job across the reschedule
 * (AC7).
 */
async function runNoAccess(
  command: ReportNoAccessCommand
): Promise<ReportNoAccessResult> {
  const op = command.operationId;

  const appointmentResult = await activities.reportNoAccessAppointment({
    operationId: `${op}/appointment`,
    appointmentId: command.appointmentId,
    contractorId: command.contractorId,
  });
  if (appointmentResult.outcome === "APPOINTMENT_NOT_FOUND") {
    return { kind: "APPOINTMENT_MISMATCH" };
  }
  if (appointmentResult.outcome === "NOT_SCHEDULED") {
    return { kind: "NOT_SCHEDULED" };
  }
  if (appointmentResult.outcome === "WRONG_CONTRACTOR") {
    return { kind: "WRONG_CONTRACTOR" };
  }
  const appointment = appointmentResult.appointment;

  const caseResult = await activities.markCaseNoAccess({
    caseId: command.caseId,
    operationId: `${op}/case`,
    actorId: command.actorId,
    actorRole: command.actorRole,
  });
  if (caseResult.outcome === "CASE_TERMINAL") {
    return { kind: "CASE_TERMINAL" };
  }

  return {
    kind: "SUCCESS",
    data: { appointment, case: caseResult.case },
  };
}

/**
 * The reschedule Saga (PRS-146 AC4/AC5), forward-only: the Appointment atom
 * retires the old slot and books the replacement in one transaction, then the
 * Case records it. A step-1 rejection means nothing was mutated — the old
 * schedule still stands, which is what makes APPOINTMENT_CONFLICT safe to
 * return to the caller as "pick another slot".
 */
async function runReplaceAppointment(
  command: ReplaceAppointmentCommand
): Promise<ReplaceAppointmentResult> {
  const op = command.operationId;

  // The atom derives its own `/claim` and `/appointment` suffixes beneath
  // this, so name the step for what it is rather than doubling `/appointment`.
  const slotResult = await activities.replaceAppointmentSlot({
    operationId: `${op}/replace`,
    caseId: command.caseId,
    appointmentId: command.appointmentId,
    startTime: command.input.startTime,
    endTime: command.input.endTime,
    reason: command.input.reason,
  });
  if (slotResult.outcome === "APPOINTMENT_NOT_FOUND") {
    return { kind: "APPOINTMENT_MISMATCH" };
  }
  if (slotResult.outcome === "CASE_MISMATCH") {
    return { kind: "CASE_MISMATCH" };
  }
  if (slotResult.outcome === "NOT_REPLACEABLE") {
    return { kind: "NOT_REPLACEABLE" };
  }
  if (slotResult.outcome === "CONFLICT") {
    return { kind: "APPOINTMENT_CONFLICT" };
  }
  const appointment = slotResult.appointment;

  const caseResult = await activities.markCaseAppointmentReplaced({
    caseId: command.caseId,
    operationId: `${op}/case`,
    actorId: command.actorId,
    actorRole: command.actorRole,
  });
  if (caseResult.outcome === "CASE_TERMINAL") {
    return { kind: "CASE_TERMINAL" };
  }

  return {
    kind: "SUCCESS",
    data: { appointment, case: caseResult.case },
  };
}

/**
 * PRS-149 expiry is intentionally narrow: it changes only the Appointment
 * and raises attention. Case, Assignment, performance, and allocation stay
 * untouched until an Officer or Resident replaces the missed visit.
 */
async function runMissedAppointment(
  caseId: string,
  appointment: CurrentAppointment
) {
  const operationId = `${caseId}/missed-appointment/${appointment.appointmentId}`;
  const result = await activities.markAppointmentMissed({
    operationId,
    appointmentId: appointment.appointmentId,
  });

  if (result.outcome === "MISSED" || result.outcome === "ALREADY_MISSED") {
    await activities.raiseOfficerAttention({
      caseId,
      kind: "MISSED_APPOINTMENT",
      detail: `Appointment ${appointment.appointmentId} ended at ${new Date(appointment.endAt).toISOString()} without work start, No Access, or Reschedule.`,
      operationId,
    });
    return;
  }

  if (result.outcome === "APPOINTMENT_NOT_FOUND") {
    await activities.raiseOfficerAttention({
      caseId,
      kind: "MISSED_APPOINTMENT",
      detail: `Appointment ${appointment.appointmentId} was not found when its ${new Date(appointment.endAt).toISOString()} expiry fired.`,
      operationId,
    });
  }
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
  const acceptanceOperations = new Map<string, AcceptanceOperation>();
  const startWorkOperations = new Map<string, StartWorkOperation>();
  const noAccessOperations = new Map<string, NoAccessOperation>();
  const replaceAppointmentOperations = new Map<
    string,
    ReplaceAppointmentOperation
  >();
  // In-Workflow only — never exposed as a Query/read model. Tracks which
  // Contractors this Workflow already committed or attempted, across
  // allocation passes for this Case's whole lifetime.
  const attemptedContractorIds = new Set<string>();
  const allocationQueue: AllocationRequest[] = [];
  let allocation: AllocationState = { status: "IDLE" };
  let automaticRetryAt: number | undefined;
  let automaticRetryDelayMs = INITIAL_ALLOCATION_RETRY_MS;
  let automaticAllocationActive = false;
  let automaticAllocationSource: "AUTO_ASSIGN" | "BREACH_REASSIGN" =
    "AUTO_ASSIGN";
  let allocationContext: AllocationContext | undefined;
  // The Attempt currently awaiting acceptance, if any (PRS-144). Armed by
  // every path that commits or discovers a PENDING_ACCEPTANCE Attempt;
  // cleared on acceptance and on breach.
  let currentAttempt: CommittedAttempt | undefined;
  let accepted = false;
  let currentAppointment: CurrentAppointment | undefined;
  // Every lifecycle transition increments this so a timerless Workflow wait
  // still re-evaluates immediately when an Appointment is armed or cleared.
  let appointmentStateRevision = 0;
  // A handler admitted before endAt settles before expiry runs; a handler that
  // first arrives at endAt fails its window gate and never acquires this guard.
  let appointmentLifecycleGuard = 0;
  // A MISSED replacement waits for this Saga to raise attention before it can
  // resolve that attention through the existing Case replacement write.
  let missedAppointmentRecovery: string | undefined;
  // Counts acceptAllocation handlers currently running the real Activity.
  // Armed synchronously before the first await so the main loop's breach
  // check can never race a handler that started before the deadline.
  let acceptanceGuard = 0;

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
      allocationQueue.push({
        kind: "AUTOMATIC",
        source: "AUTO_ASSIGN",
        ...allocationContext,
      });
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

  setHandler(acceptAllocation, async (unparsedCommand) => {
    const command = AcceptAllocationCommandSchema.parse(unparsedCommand);
    if (command.caseId !== caseId) return { kind: "CASE_MISMATCH" };

    // The idempotency cache lookup must stay before the deadline check
    // below (PRS-144 AC2): a legitimate before-deadline acceptance whose
    // retry lands after the deadline must still return its cached result,
    // not get wrongly rejected as late.
    const existing = acceptanceOperations.get(command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error("Acceptance operation has no result or pending activity");
    }

    // A new, unseen acceptance that lands after this Attempt's own deadline
    // is rejected outright, without calling the atom — this closes the
    // late-acceptance race (AC3) rather than leaving it to the atom's row
    // lock as the only defence.
    if (
      currentAttempt &&
      command.attemptId === currentAttempt.attemptId &&
      Date.now() >= currentAttempt.deadlineAt
    ) {
      return { kind: "ATTEMPT_NOT_PENDING" };
    }

    const operation: AcceptanceOperation = { payloadHash: command.payloadHash };
    acceptanceOperations.set(command.idempotencyKey, operation);
    try {
      // Armed synchronously, as the first statement in the try and before
      // the first await, so a synchronous throw from acceptAllocation still
      // hits `finally` — the main loop's deadline wait can always observe
      // an in-flight acceptance that started before the deadline, which is
      // what makes the accept Activity and the breach Activity mutually
      // exclusive.
      acceptanceGuard++;
      operation.pending = activities.acceptAllocation(command);
      operation.result = await operation.pending;
      if (operation.result.kind === "SUCCESS") {
        accepted = true;
        currentAttempt = undefined;
        currentAppointment = {
          appointmentId: operation.result.data.appointment.id,
          endAt: Date.parse(operation.result.data.appointment.endTime),
        };
        appointmentStateRevision++;
      }
      // A semantic conflict (e.g. APPOINTMENT_CONFLICT) leaves `accepted`
      // and `currentAttempt` untouched, so the Attempt still breaches.
      return operation.result;
    } catch (error) {
      acceptanceOperations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
      acceptanceGuard--;
    }
  });

  setHandler(startWork, async (unparsedCommand) => {
    const command = StartWorkCommandSchema.parse(unparsedCommand);
    if (command.caseId !== caseId) return { kind: "CASE_MISMATCH" };

    const existing = startWorkOperations.get(command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error("Start-work operation has no result or pending activity");
    }

    // The window gate runs before the cache below is populated — load-
    // bearing. A before-window NOT_IN_WINDOW is non-terminal (the window
    // opens later), so a same-key retry once startTime arrives must still be
    // able to succeed, never replay a stale rejection. SUCCESS and every
    // atom-returned terminal outcome below (WRONG_CONTRACTOR, NOT_SCHEDULED,
    // WORK_START_FAILED, …) are cached and replay on a same-key retry; the
    // catch below deletes the entry so a transient failure re-runs (mirrors
    // acceptAllocation above).
    const now = Date.now();
    if (now < Date.parse(command.startTime)) return { kind: "NOT_IN_WINDOW" };
    if (now >= Date.parse(command.endTime)) return { kind: "NOT_IN_WINDOW" };

    const guardsAppointmentExpiry =
      currentAppointment?.appointmentId === command.appointmentId;
    if (guardsAppointmentExpiry) appointmentLifecycleGuard++;

    const operation: StartWorkOperation = { payloadHash: command.payloadHash };
    startWorkOperations.set(command.idempotencyKey, operation);
    try {
      operation.pending = runStartWork(command);
      operation.result = await operation.pending;
      if (
        currentAppointment?.appointmentId === command.appointmentId &&
        (operation.result.kind === "SUCCESS" ||
          operation.result.kind === "WORK_START_FAILED" ||
          operation.result.kind === "NOT_SCHEDULED")
      ) {
        currentAppointment = undefined;
        appointmentStateRevision++;
      }
      return operation.result;
    } catch (error) {
      startWorkOperations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
      if (guardsAppointmentExpiry) appointmentLifecycleGuard--;
    }
  });

  setHandler(reportNoAccess, async (unparsedCommand) => {
    const command = ReportNoAccessCommandSchema.parse(unparsedCommand);
    if (command.caseId !== caseId) return { kind: "CASE_MISMATCH" };

    // Cache lookup ahead of the window gate, exactly as in startWork above: a
    // legitimate in-window report whose retry only lands after endTime must
    // replay its cached result rather than be rejected as out of window.
    const existing = noAccessOperations.get(command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error("No-access operation has no result or pending activity");
    }

    // Half-open [startTime, endTime), same gate as start-work: No Access is a
    // report about an attended visit, so it is only truthful while the
    // Appointment is actually running.
    const now = Date.now();
    if (now < Date.parse(command.startTime)) return { kind: "NOT_IN_WINDOW" };
    if (now >= Date.parse(command.endTime)) return { kind: "NOT_IN_WINDOW" };

    const guardsAppointmentExpiry =
      currentAppointment?.appointmentId === command.appointmentId;
    if (guardsAppointmentExpiry) appointmentLifecycleGuard++;

    const operation: NoAccessOperation = { payloadHash: command.payloadHash };
    noAccessOperations.set(command.idempotencyKey, operation);
    try {
      operation.pending = runNoAccess(command);
      operation.result = await operation.pending;
      if (
        currentAppointment?.appointmentId === command.appointmentId &&
        (operation.result.kind === "SUCCESS" ||
          operation.result.kind === "CASE_TERMINAL" ||
          operation.result.kind === "NOT_SCHEDULED")
      ) {
        currentAppointment = undefined;
        appointmentStateRevision++;
      }
      return operation.result;
    } catch (error) {
      noAccessOperations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
      if (guardsAppointmentExpiry) appointmentLifecycleGuard--;
    }
  });

  setHandler(replaceAppointment, async (unparsedCommand) => {
    const command = ReplaceAppointmentCommandSchema.parse(unparsedCommand);
    if (command.caseId !== caseId) return { kind: "CASE_MISMATCH" };

    // Same ordering rule as the two handlers above — a cached result outranks
    // a time gate that has since closed under a retry.
    const existing = replaceAppointmentOperations.get(command.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== command.payloadHash) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      if (existing.result) return existing.result;
      if (existing.pending) return await existing.pending;
      throw new Error(
        "Replace-appointment operation has no result or pending activity"
      );
    }

    const now = Date.now();
    if (Date.parse(command.input.startTime) <= now) {
      return { kind: "NOT_FUTURE" };
    }
    // AC4 permits a proactive reschedule only of a *future* SCHEDULED
    // Appointment: once its window has opened, moving it is missed-visit
    // recovery, which PRS-149 owns. A NO_ACCESS Appointment carries no such
    // constraint — rescheduling one is precisely the AC5 recovery path.
    if (
      command.previousStatus === "SCHEDULED" &&
      Date.parse(command.previousStartTime) <= now
    ) {
      return { kind: "NOT_FUTURE" };
    }

    if (
      command.previousStatus === "MISSED" &&
      missedAppointmentRecovery === command.appointmentId
    ) {
      await condition(
        () => missedAppointmentRecovery !== command.appointmentId
      );
    }

    const guardsAppointmentExpiry =
      currentAppointment?.appointmentId === command.appointmentId;
    if (guardsAppointmentExpiry) appointmentLifecycleGuard++;

    const operation: ReplaceAppointmentOperation = {
      payloadHash: command.payloadHash,
    };
    replaceAppointmentOperations.set(command.idempotencyKey, operation);
    try {
      operation.pending = runReplaceAppointment(command);
      operation.result = await operation.pending;
      if (operation.result.kind === "SUCCESS") {
        currentAppointment = {
          appointmentId: operation.result.data.appointment.id,
          endAt: Date.parse(operation.result.data.appointment.endTime),
        };
        appointmentStateRevision++;
      } else if (
        currentAppointment?.appointmentId === command.appointmentId &&
        (operation.result.kind === "NOT_REPLACEABLE" ||
          operation.result.kind === "CASE_TERMINAL")
      ) {
        currentAppointment = undefined;
        appointmentStateRevision++;
      }
      return operation.result;
    } catch (error) {
      replaceAppointmentOperations.delete(command.idempotencyKey);
      throw error;
    } finally {
      delete operation.pending;
      if (guardsAppointmentExpiry) appointmentLifecycleGuard--;
    }
  });

  // Allocation runs here, never inside an Update handler. PRS-141 extends this
  // loop with a lossless intent queue. A timed automatic poll never blocks an
  // Officer Update: `condition` wakes as soon as the queue receives a manual
  // request, while the absolute retry deadline remains intact. PRS-144 adds a
  // second timer on the same wait — the current Attempt's acceptance
  // deadline — so an unaccepted offer breaches without a manual poll.
  while (true) {
    if (allocationQueue.length === 0) {
      const deadlines: number[] = [];
      if (currentAttempt) deadlines.push(currentAttempt.deadlineAt);
      if (currentAppointment) deadlines.push(currentAppointment.endAt);
      if (!automaticAllocationActive && automaticRetryAt !== undefined) {
        deadlines.push(automaticRetryAt);
      }

      if (deadlines.length > 0) {
        const revisionAtWait = appointmentStateRevision;
        const wokeForRequest = await condition(
          () =>
            allocationQueue.length > 0 ||
            appointmentStateRevision !== revisionAtWait,
          Math.max(0, Math.min(...deadlines) - Date.now())
        );

        if (!wokeForRequest) {
          // A handler armed before the deadline must finish before this
          // check runs, or a before-deadline acceptance could lose the race
          // to the breach it should have prevented.
          if (acceptanceGuard > 0) {
            await condition(() => acceptanceGuard === 0);
          }
          if (appointmentLifecycleGuard > 0) {
            await condition(() => appointmentLifecycleGuard === 0);
          }

          if (currentAppointment && Date.now() >= currentAppointment.endAt) {
            const expiringAppointment = currentAppointment;
            missedAppointmentRecovery = expiringAppointment.appointmentId;
            try {
              await runMissedAppointment(caseId, expiringAppointment);
            } finally {
              if (
                currentAppointment?.appointmentId ===
                expiringAppointment.appointmentId
              ) {
                currentAppointment = undefined;
                appointmentStateRevision++;
              }
              missedAppointmentRecovery = undefined;
            }
          }

          if (
            currentAttempt &&
            !accepted &&
            Date.now() >= currentAttempt.deadlineAt
          ) {
            const breached = currentAttempt;
            const outcome = await runBreach(caseId, breached);
            currentAttempt = undefined;
            if (outcome.status === "REPLACED") {
              automaticAllocationActive = false;
              automaticRetryAt = undefined;
              automaticAllocationSource = "BREACH_REASSIGN";
              if (allocationContext) {
                allocationQueue.push({
                  kind: "AUTOMATIC",
                  source: "BREACH_REASSIGN",
                  ...allocationContext,
                });
              }
            } else if (outcome.status === "CASE_TERMINAL") {
              automaticAllocationActive = true;
              automaticRetryAt = undefined;
            }
            // ATTEMPT_NO_LONGER_LIVE: the offer already resolved elsewhere
            // (accepted or manually withdrawn) — nothing left to do here.
          } else if (
            !currentAttempt &&
            !automaticAllocationActive &&
            automaticRetryAt !== undefined &&
            Date.now() >= automaticRetryAt &&
            allocationContext
          ) {
            allocationQueue.push({
              kind: "AUTOMATIC",
              source: automaticAllocationSource,
              ...allocationContext,
            });
          }
        }
      } else {
        const revisionAtWait = appointmentStateRevision;
        await condition(
          () =>
            allocationQueue.length > 0 ||
            appointmentStateRevision !== revisionAtWait
        );
      }
    }

    const request = allocationQueue.shift();
    if (!request) continue;

    if (request.kind === "MANUAL") {
      let outcome: ManualAllocationOutcome;
      try {
        outcome = await runManualAllocation(
          request.command,
          attemptedContractorIds
        );
      } catch (error) {
        outcome = {
          result: {
            kind: "ALLOCATION_FAILED",
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
      const result = outcome.result;

      if (result.kind === "SUCCESS") {
        automaticAllocationActive = true;
        automaticRetryAt = undefined;
        automaticRetryDelayMs = INITIAL_ALLOCATION_RETRY_MS;
        if (outcome.attempt) {
          allocation = { status: "ALLOCATED", attempt: outcome.attempt };
          currentAttempt = outcome.attempt;
          accepted = false;
        }
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

    automaticAllocationSource = request.source;
    try {
      allocation = await runAllocation(
        caseId,
        request.source,
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
      currentAttempt = allocation.attempt;
      accepted = false;
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

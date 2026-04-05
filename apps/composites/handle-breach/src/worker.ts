import { logger, rabbitmqClient } from "@townops/shared-ts";

import { env } from "./env";

export interface SlaBreachedEvent {
  assignment_id: string;
  case_id: string;
  contractor_id?: string;
}

/**
 * Handler for sla.breached events consumed from handle-breach-queue.
 *
 * Workflow:
 * 1. Query OutSystems Contractor API for a backup worker.
 * 2. Update the Assignment to the new worker.
 * 3. Update Case status to "escalated".
 * 4. Record a penalty in the Metrics atom.
 * 5. Publish case.escalated event to townops.events (for Alert service).
 */
export async function handleSlaBreach(message: any): Promise<void> {
  let event: SlaBreachedEvent;

  try {
    const raw =
      typeof message === "string"
        ? message
        : (message.bodyString?.() ?? JSON.stringify(message));
    event = JSON.parse(raw) as SlaBreachedEvent;
  } catch {
    logger.error(
      { message },
      "handle-breach: failed to parse sla.breached message"
    );
    return;
  }

  if (!event.assignment_id || !event.case_id) {
    logger.error(
      { event },
      "handle-breach: invalid sla.breached payload — missing assignment_id or case_id"
    );
    return;
  }

  logger.info(
    { assignmentId: event.assignment_id, caseId: event.case_id },
    "handle-breach: processing sla.breached event"
  );

  // Step 1: Query backup contractor
  const backupRes = await fetch(
    `${env.CONTRACTOR_API_URL}/contractors/backup?case_id=${event.case_id}`
  );
  if (!backupRes.ok) {
    throw new Error(`Backup contractor query failed: HTTP ${backupRes.status}`);
  }
  const backupData = await backupRes.json();
  const newWorkerId = backupData.worker_id ?? "fallback_worker_01";

  // Step 2: Update assignment to new worker
  const assignRes = await fetch(
    `${env.ASSIGNMENT_ATOM_URL}/api/assignments/${event.assignment_id}/status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "REASSIGNED",
        changedBy: newWorkerId,
        reason: "SLA_BREACH",
      }),
    }
  );
  if (!assignRes.ok) {
    throw new Error(`Assignment reassignment failed: HTTP ${assignRes.status}`);
  }

  // Step 3: Update case to escalated
  const caseRes = await fetch(
    `${env.CASE_ATOM_URL}/api/cases/update-case-status/`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: event.case_id, status: "escalated" }),
    }
  );
  if (!caseRes.ok) {
    throw new Error(`Case escalation failed: HTTP ${caseRes.status}`);
  }

  // Step 4: Record penalty in Metrics
  const metricsRes = await fetch(`${env.METRICS_ATOM_URL}/api/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractorId: event.contractor_id,
      scoreDelta: -10,
      reason: "SLA_BREACH_NO_ACKNOWLEDGEMENT",
    }),
  });
  if (!metricsRes.ok) {
    throw new Error(`Penalty recording failed: HTTP ${metricsRes.status}`);
  }

  // Step 5: Publish case.escalated event
  await rabbitmqClient.publish("townops.events", "case.escalated", {
    caseId: event.case_id,
    assignmentId: event.assignment_id,
    newWorkerId,
    message: `Case ${event.case_id} escalated due to SLA breach. Reassigned to ${newWorkerId}.`,
  });

  logger.info(
    { assignmentId: event.assignment_id, caseId: event.case_id },
    "handle-breach: sla.breached processed successfully"
  );
}

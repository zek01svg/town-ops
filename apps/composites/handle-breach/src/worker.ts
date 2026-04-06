import { logger, rabbitmqClient, captureException } from "@townops/shared-ts";

import { env } from "./env";

export interface SlaBreachedEvent {
  assignment_id: string;
  case_id: string;
  contractor_id?: string;
  postal_code?: string;
  category_code?: string;
}

/**
 * Handler for sla.breached events consumed from handle-breach-queue.
 *
 * Workflow:
 * 1. Search OutSystems for a backup contractor (same sector/category, exclude current).
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
    captureException(new Error("Failed to parse sla.breached message"), {
      serviceName: "handle-breach-worker",
      extra: { message },
    });
    return;
  }

  if (!event.assignment_id || !event.case_id) {
    logger.error(
      { event },
      "handle-breach: invalid sla.breached payload — missing assignment_id or case_id"
    );
    captureException(new Error("Invalid sla.breached payload"), {
      serviceName: "handle-breach-worker",
      extra: { event },
    });
    return;
  }

  const assignmentRes = await fetch(
    `${env.ASSIGNMENT_ATOM_URL}/api/assignments/${event.case_id}`
  );
  if (!assignmentRes.ok) {
    logger.warn(
      { caseId: event.case_id },
      "handle-breach: assignment not found for case"
    );
    return;
  }
  const assignmentPayload = await assignmentRes.json();
  const assignment = assignmentPayload.assignments ?? assignmentPayload;
  if (!assignment?.id) {
    logger.warn(
      { caseId: event.case_id },
      "handle-breach: assignment lookup returned empty"
    );
    return;
  }
  if (assignment.id !== event.assignment_id) {
    logger.info(
      {
        caseId: event.case_id,
        expectedAssignment: event.assignment_id,
        currentAssignment: assignment.id,
      },
      "handle-breach: assignment already reassigned, skipping"
    );
    return;
  }
  if (assignment.status !== "PENDING_ACCEPTANCE") {
    logger.info(
      {
        assignmentId: assignment.id,
        status: assignment.status,
      },
      "handle-breach: assignment already acknowledged, skipping"
    );
    return;
  }

  logger.info(
    { assignmentId: event.assignment_id, caseId: event.case_id },
    "handle-breach: processing sla.breached event"
  );

  // Step 1: Search OutSystems for a backup contractor (same sector/category, exclude current)
  const sectorCode = (event.postal_code ?? "").slice(0, 2);
  const category = event.category_code ?? "";
  if (!sectorCode || !category) {
    throw new Error(
      "SLA breach payload missing postal_code or category_code — cannot search for backup contractor"
    );
  }
  const searchUrl = new URL(`${env.CONTRACTOR_API_URL}/contractors/search`);
  searchUrl.searchParams.set("SectorCode", sectorCode);
  searchUrl.searchParams.set("CategoryCode", category);
  const searchRes = await fetch(searchUrl.toString());
  if (!searchRes.ok) {
    throw new Error(`Contractor search failed: HTTP ${searchRes.status}`);
  }
  const candidates: Array<{ ContractorUuid: string }> = await searchRes.json();
  const backup = candidates.find(
    (c) =>
      c.ContractorUuid.startsWith("c0ffee01") &&
      c.ContractorUuid !== event.contractor_id
  );
  if (!backup) {
    throw new Error("No backup contractor available for sector/category");
  }
  const newWorkerId = backup.ContractorUuid;

  logger.info(
    { newWorkerId, oldWorkerId: event.contractor_id },
    "handle-breach: backup contractor selected"
  );

  // Step 3: Update assignment to new worker
  const assignRes = await fetch(
    `${env.ASSIGNMENT_ATOM_URL}/api/assignments/${event.assignment_id}/reassign`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractorId: newWorkerId,
        responseDueAt: new Date(Date.now() + 15 * 1000).toISOString(),
        changedBy: newWorkerId,
        reason: "SLA_BREACH",
      }),
    }
  );
  if (!assignRes.ok) {
    throw new Error(`Assignment reassignment failed: HTTP ${assignRes.status}`);
  }

  // Step 4: Update case to escalated
  const caseRes = await fetch(
    `${env.CASE_ATOM_URL}/api/cases/update-case-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: event.case_id, status: "escalated" }),
    }
  );
  if (!caseRes.ok) {
    throw new Error(`Case escalation failed: HTTP ${caseRes.status}`);
  }

  // Step 5: Record penalty in Metrics
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
    const err = new Error(
      `Penalty recording failed: HTTP ${metricsRes.status}`
    );
    captureException(err, { serviceName: "handle-breach-worker" });
    throw err;
  }

  // Step 6: Publish case.escalated event
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

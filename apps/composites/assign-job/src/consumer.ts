import { logger } from "@townops/shared-ts";

import { assignContractor } from "./services";

export interface CaseOpenedEvent {
  caseId: string;
  residentId: string;
  category: string;
  priority: string;
  postalCode?: string;
  addressDetails?: string;
  description?: string;
}

/**
 * Handler for case.opened events consumed from the assign-job-queue.
 * Orchestrates contractor selection and assignment creation.
 */
export async function handleCaseOpened(message: any): Promise<void> {
  let event: CaseOpenedEvent;

  try {
    const raw =
      typeof message === "string"
        ? message
        : (message.bodyString?.() ?? JSON.stringify(message));
    event = JSON.parse(raw) as CaseOpenedEvent;
  } catch {
    logger.error(
      { message },
      "assign-job: failed to parse case.opened message"
    );
    return;
  }

  if (!event.caseId) {
    logger.error(
      { event },
      "assign-job: invalid case.opened payload — missing caseId"
    );
    return;
  }

  const postalCode =
    event.postalCode ?? event.addressDetails?.slice(0, 6) ?? "000000";
  const categoryCode = event.category;

  logger.info(
    { caseId: event.caseId, postalCode, categoryCode },
    "assign-job: processing case.opened event"
  );

  await assignContractor(event.caseId, postalCode, categoryCode);
}

interface BaseTemplateParams {
  caseId: string;
  category?: string;
  contractor?: string;
  description?: string;
}

/**
 * Template for case.opened event.
 */
export function getCaseOpenedEmail({
  caseId,
  category,
  contractor,
  description,
}: BaseTemplateParams) {
  return `
    <h1>Case Opened</h1>
    <p>A new case has been opened in the TownOps system.</p>
    <ul>
      <li><strong>Case ID:</strong> ${caseId}</li>
      <li><strong>Category:</strong> ${category || "General"}</li>
      <li><strong>Contractor:</strong> ${contractor || "Unassigned"}</li>
    </ul>
    <p><strong>Description:</strong></p>
    <blockquote>${description || "No description provided"}</blockquote>
    <p>Please check the TownOps portal for more details.</p>
  `;
}

/**
 * Template for job.assigned event.
 */
export function getJobAssignedEmail({ caseId }: BaseTemplateParams) {
  return `
    <h1>Job Assigned</h1>
    <p>You have been assigned to handle a job for the following case:</p>
    <ul>
      <li><strong>Case ID:</strong> ${caseId}</li>
    </ul>
    <p>Please review the details in the TownOps portal and commence action as scheduled.</p>
  `;
}

/**
 * Template for case.escalated event.
 */
export function getCaseEscalatedEmail({ caseId }: BaseTemplateParams) {
  return `
    <h1>Case Escalated</h1>
    <p>The following case has been escalated and requires secondary review:</p>
    <ul>
      <li><strong>Case ID:</strong> ${caseId}</li>
    </ul>
    <p>Please access the dashboard for case escalation processing.</p>
  `;
}

/**
 * Template for case.no_access event.
 */
export function getCaseNoAccessEmail({ caseId }: BaseTemplateParams) {
  return `
    <h1>Access Issue Encountered</h1>
    <p>An access issue has been reported for the following case:</p>
    <ul>
      <li><strong>Case ID:</strong> ${caseId}</li>
    </ul>
    <p>A contractor was unable to access the property. Please review or coordinate access protocols.</p>
  `;
}

/**
 * Template for job.done event.
 */
export function getJobCompletedEmail({ caseId }: BaseTemplateParams) {
  return `
    <h1>Job Completed</h1>
    <p>The job associated with your case has been resolved successfully:</p>
    <ul>
      <li><strong>Case ID:</strong> ${caseId}</li>
    </ul>
    <p>View full completion reports on the portal.</p>
  `;
}

/**
 * Generic Fallback Alert Template.
 */
export function getGenericAlertEmail({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return `
    <h1>${title}</h1>
    <p>${message}</p>
    <p>Check the TownOps portal for more details.</p>
  `;
}

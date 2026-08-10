import { proxyActivities } from "@temporalio/workflow";
import { ProvisionResidentInputSchema } from "@townops/orchestration-contract";
import type {
  ProvisionResidentInput,
  ResidentProfileDto,
} from "@townops/orchestration-contract";

const activities = proxyActivities<{
  provisionResidentProfile(
    input: ProvisionResidentInput
  ): Promise<ResidentProfileDto>;
}>({ startToCloseTimeout: "10 seconds" });

/**
 * Durable owner of a Resident's profile provisioning. Its Workflow ID
 * derives from the Account ID, so repeated signup / sign-in / current-user
 * reconciliation attempts attach to the same run instead of creating a
 * second profile. The underlying Activity is idempotent, so an interrupted
 * run resumes safely.
 */
export async function ResidentProvisioningWorkflow(
  input: ProvisionResidentInput
) {
  const command = ProvisionResidentInputSchema.parse(input);
  return activities.provisionResidentProfile(command);
}

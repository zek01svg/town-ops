import { ApplicationFailure } from "@temporalio/activity";
import {
  ProvisionResidentInputSchema,
  ResidentProfileDtoSchema,
  withServerlessAuth,
} from "@townops/orchestration-contract";
import type {
  ProvisionResidentInput,
  ResidentProfileDto,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

const residentAtomResponseSchema = z.object({ resident: z.unknown() });

type ProvisionResidentActivityDependencies = {
  residentAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
  // Mints the Cloud Run IAM ID token `withServerlessAuth` attaches to every
  // atom call (PRS-140 Phase 5). Defaults to the real metadata-server minter.
  mintIdentityToken?: (audience: string) => Promise<string | undefined>;
};

function nonRetryable(message: string, type: string) {
  return ApplicationFailure.nonRetryable(message, type);
}

/**
 * Writes the Resident's profile through the Resident atom's idempotent
 * internal endpoint. The atom converges retried calls onto one row keyed by
 * the Account ID, so this Activity can be safely retried by Temporal.
 */
export function createProvisionResidentActivity({
  residentAtomUrl,
  workerServiceToken,
  fetchImpl: injectedFetch = fetch,
  mintIdentityToken,
}: ProvisionResidentActivityDependencies) {
  const fetchImpl = withServerlessAuth(injectedFetch, mintIdentityToken);
  return async function provisionResidentProfile(
    input: ProvisionResidentInput
  ): Promise<ResidentProfileDto> {
    const command = ProvisionResidentInputSchema.parse(input);
    const response = await fetchImpl(`${residentAtomUrl}/internal/residents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerServiceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw nonRetryable(
          "Resident atom rejected the provisioning operation",
          "RESIDENT_PROVISIONING_REJECTED"
        );
      }
      throw new Error(`Resident atom request failed with ${response.status}`);
    }

    const parsedResident = residentAtomResponseSchema.safeParse(
      await response.json()
    );
    if (!parsedResident.success) {
      throw new Error("Resident atom returned an invalid response");
    }

    return ResidentProfileDtoSchema.parse(parsedResident.data.resident);
  };
}

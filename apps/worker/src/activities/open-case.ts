import { ApplicationFailure } from "@temporalio/activity";
import {
  CaseDtoSchema,
  CreateCaseActivityInputSchema,
} from "@townops/orchestration-contract";
import type {
  CaseDto,
  CreateCaseActivityInput,
} from "@townops/orchestration-contract";
import { z } from "zod/v4";

const residentResponseSchema = z.object({
  residents: z.array(z.object({ id: z.uuid() })),
});
const caseResponseSchema = z.object({
  case: z.record(z.string(), z.unknown()),
});

type OpenCaseActivityDependencies = {
  residentAtomUrl: string;
  caseAtomUrl: string;
  workerServiceToken: string;
  fetchImpl?: typeof fetch;
};

function nonRetryable(message: string, type: string) {
  return ApplicationFailure.nonRetryable(message, type);
}

/**
 * Validates the Resident exists before sending the deterministic operation to
 * the Case atom. The atom is the sole persistence owner for both its Case and
 * the initial business-history row.
 */
export function createOpenCaseActivity({
  residentAtomUrl,
  caseAtomUrl,
  workerServiceToken,
  fetchImpl = fetch,
}: OpenCaseActivityDependencies) {
  return async function openCase(
    input: CreateCaseActivityInput
  ): Promise<CaseDto> {
    const command = CreateCaseActivityInputSchema.parse(input);
    const residentResponse = await fetchImpl(
      `${residentAtomUrl}/api/residents/${command.input.residentId}`,
      { headers: { Authorization: `Bearer ${workerServiceToken}` } }
    );

    if (!residentResponse.ok) {
      if (residentResponse.status === 404) {
        throw nonRetryable("Resident does not exist", "RESIDENT_NOT_FOUND");
      }
      throw new Error(
        `Resident atom request failed with ${residentResponse.status}`
      );
    }

    const resident = residentResponseSchema.safeParse(
      await residentResponse.json()
    );
    if (!resident.success || resident.data.residents.length === 0) {
      throw nonRetryable("Resident does not exist", "RESIDENT_NOT_FOUND");
    }

    const caseResponse = await fetchImpl(`${caseAtomUrl}/internal/cases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workerServiceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!caseResponse.ok) {
      if (caseResponse.status >= 400 && caseResponse.status < 500) {
        throw nonRetryable(
          "Case atom rejected the opening operation",
          "CASE_WRITE_REJECTED"
        );
      }
      throw new Error(`Case atom request failed with ${caseResponse.status}`);
    }

    const parsedCase = caseResponseSchema.safeParse(await caseResponse.json());
    if (!parsedCase.success) {
      throw new Error("Case atom returned an invalid response");
    }

    const record = parsedCase.data.case;
    return CaseDtoSchema.parse({
      ...record,
      category: String(record.category).toUpperCase(),
      priority: String(record.priority).toUpperCase(),
      status: String(record.status).toUpperCase(),
      addressDetails: record.addressDetails ?? null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
    });
  };
}

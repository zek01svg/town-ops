export const caseKeys = {
  all: ["cases"] as const,
  detail: (id: string) => ["cases", id] as const,
  appointments: (caseId: string) => ["appointments", caseId] as const,
  assignment: (caseId: string) => ["assignments", caseId] as const,
  proofItems: (caseId: string) => ["proof-items", caseId] as const,
};

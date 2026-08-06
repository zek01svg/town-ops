export const caseKeys = {
  all: ["cases"] as const,
  detail: (id: string) => ["cases", id] as const,
  assignment: (caseId: string) => ["assignments", caseId] as const,
  proofItems: (caseId: string) => ["proof-items", caseId] as const,
  // Kept as `["audit", "timeline", caseId]` — the key predates the move onto
  // the Gateway (151-E) and nothing that invalidates it needs touching.
  timeline: (caseId: string) => ["audit", "timeline", caseId] as const,
};

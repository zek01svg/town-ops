export const caseKeys = {
  all: ["cases"] as const,
  detail: (id: string) => ["cases", id] as const,
  assignment: (caseId: string) => ["assignments", caseId] as const,
  gatewayCase: (caseId: string) => ["gateway-case", caseId] as const,
  effects: (caseId: string) => ["case-effects", caseId] as const,
};

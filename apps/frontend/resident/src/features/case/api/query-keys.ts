export const caseKeys = {
  list: ["cases"] as const,
  detail: (id: string) => ["cases", id] as const,
  timeline: (id: string) => ["cases", id, "timeline"] as const,
};

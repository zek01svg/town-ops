type EffectIntent = {
  id: string;
  caseId: string;
  type: "EMAIL" | "PERFORMANCE_ENTRY";
  purpose: string;
};

function effect(
  input: EffectIntent,
  status: "PENDING" | "SENT" | "FAILED" | "UNKNOWN" | "WAIVED"
) {
  return {
    id: input.id,
    caseId: input.caseId,
    type: input.type,
    purpose: input.purpose,
    status,
    providerId: null,
    providerIdempotencyKey: input.id,
    attempts: 1,
    lastError: null,
    nextRetryAt: null,
    waiverActorId: null,
    waiverReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function immediateDerivedEffectActivities(options?: {
  onPerformanceDispatch?: (input: {
    id: string;
    contractorId: string;
    scoreDelta: number;
    reason: string;
  }) => void;
}) {
  return {
    reserveEffect: async (input: EffectIntent) => effect(input, "PENDING"),
    dispatchEmailEffect: async (input: { id: string }) =>
      effect(
        {
          id: input.id,
          caseId: "00000000-0000-0000-0000-000000000000",
          type: "EMAIL",
          purpose: "TEST",
        },
        "SENT"
      ),
    dispatchPerformanceEffect: async (input: {
      id: string;
      contractorId: string;
      scoreDelta: number;
      reason: string;
    }) => {
      options?.onPerformanceDispatch?.(input);
      return effect(
        {
          id: input.id,
          caseId: "00000000-0000-0000-0000-000000000000",
          type: "PERFORMANCE_ENTRY",
          purpose: "TEST",
        },
        "SENT"
      );
    },
    markEffectUnknown: async (id: string) =>
      effect(
        {
          id,
          caseId: "00000000-0000-0000-0000-000000000000",
          type: "EMAIL",
          purpose: "TEST",
        },
        "UNKNOWN"
      ),
    retryEffect: async () => ({ kind: "NOT_REPAIRABLE" as const }),
    waiveEffect: async (input: { id: string }) =>
      effect(
        {
          id: input.id,
          caseId: "00000000-0000-0000-0000-000000000000",
          type: "EMAIL",
          purpose: "TEST",
        },
        "WAIVED"
      ),
    raiseDerivedEffectAttention: async () => undefined,
    resolveDerivedEffectAttention: async () => undefined,
  };
}

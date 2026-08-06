import { queryOptions } from "@tanstack/react-query";
import { OfficerAttentionDtoSchema } from "@townops/orchestration-contract";
import { gatewayFetch } from "@townops/ui/libr/gateway";
import { z } from "zod/v4";

import { env } from "@/env";

export const attentionKeys = {
  list: (state: "open" | "resolved") => ["officer-attention", state] as const,
};

const attentionResponseSchema = z.object({
  data: z.object({ items: z.array(OfficerAttentionDtoSchema) }),
});

export const attentionQueries = {
  list: (state: "open" | "resolved" = "open") =>
    queryOptions({
      queryKey: attentionKeys.list(state),
      enabled: !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        // ponytail: pin pageSize to the schema max (100) — the default is
        // 25, which would silently drop older open items off a busy board.
        const body = await gatewayFetch(
          `${env.VITE_GATEWAY_URL}/api/officer-attention?state=${state}&pageSize=100`,
          {},
          env.VITE_AUTH_URL
        );
        const parsed = attentionResponseSchema.safeParse(body);
        if (!parsed.success) {
          throw new Error("Invalid officer attention response");
        }
        return parsed.data.data.items;
      },
    }),
};

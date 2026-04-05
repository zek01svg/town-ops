import { z } from "zod/v4";

export const acceptJobSchema = z.object({
  case_id: z.string().uuid(),
  assignment_id: z.string().uuid(),
  contractor_id: z.string().uuid(),
  start_time: z.string().datetime({ offset: true }),
  end_time: z.string().datetime({ offset: true }),
});

export type AcceptJobInput = z.infer<typeof acceptJobSchema>;

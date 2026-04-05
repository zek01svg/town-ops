import { z } from "zod/v4";

export const handleBreachSchema = z.object({
  assignment_id: z.string().uuid(),
  case_id: z.string().uuid(),
  breach_details: z.string().min(1),
  new_assignee_id: z.string().min(1),
  penalty: z.number().positive(),
});

export type HandleBreachInput = z.infer<typeof handleBreachSchema>;

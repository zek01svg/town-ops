import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(6002),
    RABBITMQ_URL: z.string(),
    CONTRACTOR_API_URL: z.url(),
    ASSIGNMENT_ATOM_URL: z.url(),
    METRICS_ATOM_URL: z.url(),
  },
  runtimeEnv: {
    PORT: Number(process.env.PORT),
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    CONTRACTOR_API_URL: process.env.CONTRACTOR_API_URL,
    ASSIGNMENT_ATOM_URL: process.env.ASSIGNMENT_ATOM_URL,
    METRICS_ATOM_URL: process.env.METRICS_ATOM_URL,
  },
  skipValidation: process.env.npm_lifecycle_event === "lint",
});

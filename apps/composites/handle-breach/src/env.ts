import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(6005),
    RABBITMQ_URL: z.string(),
    CASE_ATOM_URL: z.url(),
    ASSIGNMENT_ATOM_URL: z.url(),
    METRICS_ATOM_URL: z.url(),
    CONTRACTOR_ATOM_URL: z.url(),
    JWKS_URI: z.url(),
  },
  runtimeEnv: {
    PORT: Number(process.env.PORT),
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    CASE_ATOM_URL: process.env.CASE_ATOM_URL,
    ASSIGNMENT_ATOM_URL: process.env.ASSIGNMENT_ATOM_URL,
    METRICS_ATOM_URL: process.env.METRICS_ATOM_URL,
    CONTRACTOR_ATOM_URL: process.env.CONTRACTOR_ATOM_URL,
    JWKS_URI: process.env.JWKS_URI,
  },
  skipValidation: process.env.npm_lifecycle_event === "lint",
});

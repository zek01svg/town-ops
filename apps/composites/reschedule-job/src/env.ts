import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(6006),
    RABBITMQ_URL: z.string(),
    RESIDENT_ATOM_URL: z.url(),
    APPOINTMENT_ATOM_URL: z.url(),
    CASE_ATOM_URL: z.url(),
    JWKS_URI: z.url(),
  },
  runtimeEnv: {
    PORT: Number(process.env.PORT),
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    RESIDENT_ATOM_URL: process.env.RESIDENT_ATOM_URL,
    APPOINTMENT_ATOM_URL: process.env.APPOINTMENT_ATOM_URL,
    CASE_ATOM_URL: process.env.CASE_ATOM_URL,
    JWKS_URI: process.env.JWKS_URI,
  },
  skipValidation: process.env.npm_lifecycle_event === "lint",
});

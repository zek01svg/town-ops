import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string(),
    PORT: z.coerce.number().default(5000),
    RABBITMQ_URL: z.string(),
    RESEND_API_KEY: z.string(),
    JWKS_URI: z.string().url(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: Number(process.env.PORT),
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    JWKS_URI: process.env.JWKS_URI,
  },
  skipValidation:
    process.env.npm_lifecycle_event === "lint" ||
    process.env.NODE_ENV === "test" ||
    !!process.env.VITEST,
});

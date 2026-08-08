import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string(),
    PORT: z.coerce.number().default(5000),
    RESEND_API_KEY: z.string(),
    WORKER_SERVICE_TOKEN: z.string().min(32),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: Number(process.env.PORT),
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    WORKER_SERVICE_TOKEN: process.env.WORKER_SERVICE_TOKEN,
  },
  skipValidation:
    process.env.npm_lifecycle_event === "lint" ||
    process.env.NODE_ENV === "test" ||
    !!process.env.VITEST,
});

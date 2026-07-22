import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string(),
    PORT: z.coerce.number().default(5001),
    WORKER_SERVICE_TOKEN: z.string().min(32),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: Number(process.env.PORT),
    WORKER_SERVICE_TOKEN: process.env.WORKER_SERVICE_TOKEN,
  },
  skipValidation: process.env.npm_lifecycle_event === "lint",
});

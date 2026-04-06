import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string(),
    PORT: z.coerce.number().default(5000),
    SUPABASE_URL: z.string().url(),
    SUPABASE_KEY: z.string(),
    SUPABASE_BUCKET: z.string().default("proofs"),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: Number(process.env.PORT),
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    SUPABASE_BUCKET: process.env.SUPABASE_BUCKET,
  },
  skipValidation: process.env.npm_lifecycle_event === "lint",
});

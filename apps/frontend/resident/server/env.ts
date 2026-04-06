import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  client: {
    VITE_APP_URL: z.url(),
    VITE_AUTH_URL: z.url(),
    VITE_RESCHEDULE_JOB_URL: z.url(),
  },
  server: {
    NODE_ENV: z.enum(["development", "production"]).default("development"),
  },
  clientPrefix: "VITE_",
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    VITE_APP_URL: process.env.VITE_APP_URL ?? `http://localhost:4000`,
    VITE_AUTH_URL: process.env.VITE_AUTH_URL ?? `http://localhost:5008`,
    VITE_RESCHEDULE_JOB_URL:
      process.env.VITE_RESCHEDULE_JOB_URL ?? `http://localhost:6006`,
  },
  skipValidation:
    !!process.env.CI || process.env.npm_lifecycle_event === "lint",
});

export type Env = {
  [K in keyof typeof env as K extends `VITE_${string}` ? K : never]: string;
};

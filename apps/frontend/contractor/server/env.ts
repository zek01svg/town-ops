import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  client: {
    VITE_APP_URL: z.url(),
    VITE_AUTH_URL: z.url(),
    VITE_CASE_ATOM_URL: z.url(),
    VITE_ASSIGNMENT_ATOM_URL: z.url(),
    VITE_APPOINTMENT_ATOM_URL: z.url(),
    VITE_ACCEPT_JOB_URL: z.url(),
    VITE_CLOSE_CASE_URL: z.url(),
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
    VITE_CASE_ATOM_URL:
      process.env.VITE_CASE_ATOM_URL ?? `http://localhost:5001`,
    VITE_ASSIGNMENT_ATOM_URL:
      process.env.VITE_ASSIGNMENT_ATOM_URL ?? `http://localhost:5003`,
    VITE_APPOINTMENT_ATOM_URL:
      process.env.VITE_APPOINTMENT_ATOM_URL ?? `http://localhost:5004`,
    VITE_ACCEPT_JOB_URL:
      process.env.VITE_ACCEPT_JOB_URL ?? `http://localhost:6003`,
    VITE_CLOSE_CASE_URL:
      process.env.VITE_CLOSE_CASE_URL ?? `http://localhost:6004`,
    VITE_RESCHEDULE_JOB_URL:
      process.env.VITE_RESCHEDULE_JOB_URL ?? `http://localhost:6006`,
  },
  skipValidation:
    !!process.env.CI || process.env.npm_lifecycle_event === "lint",
});

export type Env = {
  [K in keyof typeof env as K extends `VITE_${string}` ? K : never]: string;
};

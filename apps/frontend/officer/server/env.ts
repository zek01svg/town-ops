import { createEnv } from "@t3-oss/env-core";
import { z } from "zod/v4";

export const env = createEnv({
  client: {
    VITE_APP_URL: z.url(),
    VITE_AUTH_URL: z.url(),
    VITE_CASE_ATOM_URL: z.url(),
    VITE_ASSIGNMENT_ATOM_URL: z.url(),
    VITE_APPOINTMENT_ATOM_URL: z.url(),
    VITE_ALERT_ATOM_URL: z.url(),
    VITE_PROOF_ATOM_URL: z.url(),
    VITE_CONTRACTOR_ATOM_URL: z.url(),
    VITE_OPEN_CASE_URL: z.url(),
    VITE_HANDLE_BREACH_URL: z.url(),
    VITE_GOOGLE_MAPS_API_KEY: z.string().min(1),
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
    VITE_PROOF_ATOM_URL:
      process.env.VITE_PROOF_ATOM_URL ?? `http://localhost:5005`,
    VITE_ALERT_ATOM_URL:
      process.env.VITE_ALERT_ATOM_URL ?? `http://localhost:5006`,
    VITE_CONTRACTOR_ATOM_URL:
      process.env.VITE_CONTRACTOR_ATOM_URL ?? `http://localhost:5009`,
    VITE_OPEN_CASE_URL:
      process.env.VITE_OPEN_CASE_URL ?? `http://localhost:6001`,
    VITE_HANDLE_BREACH_URL:
      process.env.VITE_HANDLE_BREACH_URL ?? `http://localhost:6005`,
    VITE_GOOGLE_MAPS_API_KEY: process.env.VITE_GOOGLE_MAPS_API_KEY ?? "",
  },
  skipValidation:
    !!process.env.CI || process.env.npm_lifecycle_event === "lint",
});

export type Env = {
  [K in keyof typeof env as K extends `VITE_${string}` ? K : never]: string;
};

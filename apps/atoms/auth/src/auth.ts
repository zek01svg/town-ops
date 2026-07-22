import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, openAPI } from "better-auth/plugins";

import db from "./database/db";
import * as schema from "./database/schema";
import { env } from "./env";

const socialProviders =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }
    : undefined;

export const auth = betterAuth({
  plugins: [jwt(), openAPI()],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
  socialProviders,
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
  trustedOrigins: [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
  ],
  /**
   * `input: false` on both fields means public sign-up can never elect
   * Officer or Contractor status, or link a Contractor ID, itself — those
   * are seeded internally only.
   */
  user: {
    additionalFields: {
      role: {
        type: "string",
        input: false,
        required: true,
        defaultValue: "RESIDENT",
      },
      contractorId: {
        type: "string",
        fieldName: "contractor_id",
        input: false,
        required: false,
      },
    },
  },
});

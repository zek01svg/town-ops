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

/**
 * The browser never talks to this atom directly — the Gateway proxies
 * `/api/auth/*` and forwards the browser's `Origin` header verbatim. Better
 * Auth rejects any POST whose `Origin` is not trusted (`validateOrigin` in
 * `api/middlewares/origin-check`), and a deployed frontend's origin is its own
 * `run.app` URL, not the Gateway's `baseURL`. Without this every sign-in and
 * sign-up in a deployed environment returns 403 INVALID_ORIGIN.
 */
const deployedTrustedOrigins =
  env.AUTH_TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

export const auth = betterAuth({
  plugins: [
    jwt({
      jwt: {
        definePayload: ({ user }) => ({
          name: user.name,
          email: user.email,
          role: user.role,
          contractorId: user.contractorId ?? null,
        }),
      },
    }),
    openAPI(),
  ],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  emailAndPassword: { enabled: true },
  socialProviders,
  advanced: {
    database: {
      generateId: "uuid",
    },
    // Better Auth defaults the session cookie to SameSite=Lax. Deployed, the
    // cookie is set on the Gateway's `run.app` host while the browser's origin
    // is a frontend's `run.app` host, and `run.app` is on the Public Suffix
    // List -- so those are cross-SITE, and a Lax cookie is simply never
    // attached to the frontend's XHR. curl ignores SameSite entirely, so this
    // breaks only in a real browser and only after deployment.
    // Local dev deliberately keeps Lax: every localhost port is the same site,
    // and SameSite=None demands Secure, which plain http cannot satisfy.
    ...(env.BETTER_AUTH_URL.startsWith("https://") && {
      defaultCookieAttributes: { sameSite: "none", secure: true },
    }),
  },
  trustedOrigins: [
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    ...deployedTrustedOrigins,
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

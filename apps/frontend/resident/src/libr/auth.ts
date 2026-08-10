import { createAuthClient } from "better-auth/client";

import { env } from "../env";

/**
 * Signup and sign-in go through the Gateway's auth proxy rather than straight
 * to the auth atom, so the Gateway can start Resident profile provisioning as
 * the Account is created and the browser keeps one backend origin.
 */
export const auth = createAuthClient({
  baseURL: env.VITE_GATEWAY_URL + "/api/auth",
});

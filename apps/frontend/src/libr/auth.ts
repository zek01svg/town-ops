import { createAuthClient } from "better-auth/client";

import { env } from "../env";

export const auth = createAuthClient({
  baseURL: env.VITE_APP_URL + "/api/auth",
});

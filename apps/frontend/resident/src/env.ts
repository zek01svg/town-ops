import type { Env } from "../server/env";

const runtimeEnv = window["__env"];

export const env: Env = {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  VITE_APP_URL:
    runtimeEnv?.VITE_APP_URL ??
    import.meta.env.VITE_APP_URL ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:5173"),
  VITE_GATEWAY_URL:
    runtimeEnv?.VITE_GATEWAY_URL ??
    import.meta.env.VITE_GATEWAY_URL ??
    "http://localhost:6010",
};

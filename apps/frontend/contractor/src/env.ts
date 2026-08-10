import type { Env } from "../server/env";

const runtimeEnv = window["__env"];

export const env: Env = {
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
  VITE_GOOGLE_MAPS_API_KEY:
    runtimeEnv?.VITE_GOOGLE_MAPS_API_KEY ??
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY ??
    "",
};

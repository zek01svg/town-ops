import type { Env } from "../server/env";

export const env: Env = {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  VITE_APP_URL:
    window.__env?.VITE_APP_URL ??
    import.meta.env.VITE_APP_URL ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:5173"),
  VITE_AUTH_URL:
    window.__env?.VITE_AUTH_URL ??
    import.meta.env.VITE_AUTH_URL ??
    "http://localhost:5008",
  VITE_RESCHEDULE_JOB_URL:
    window.__env?.VITE_RESCHEDULE_JOB_URL ??
    import.meta.env.VITE_RESCHEDULE_JOB_URL ??
    "http://localhost:6006",
};

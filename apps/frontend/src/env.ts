import type { Env } from "../server/env";

export const env: Env = {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  VITE_APP_URL:
    window.__env?.VITE_APP_URL ??
    import.meta.env.VITE_APP_URL ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:5173"),
};

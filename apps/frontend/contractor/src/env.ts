import type { Env } from "../server/env";

export const env: Env = {
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
  VITE_CASE_ATOM_URL:
    window.__env?.VITE_CASE_ATOM_URL ??
    import.meta.env.VITE_CASE_ATOM_URL ??
    "http://localhost:5001",
  VITE_ASSIGNMENT_ATOM_URL:
    window.__env?.VITE_ASSIGNMENT_ATOM_URL ??
    import.meta.env.VITE_ASSIGNMENT_ATOM_URL ??
    "http://localhost:5003",
  VITE_APPOINTMENT_ATOM_URL:
    window.__env?.VITE_APPOINTMENT_ATOM_URL ??
    import.meta.env.VITE_APPOINTMENT_ATOM_URL ??
    "http://localhost:5004",
  VITE_ACCEPT_JOB_URL:
    window.__env?.VITE_ACCEPT_JOB_URL ??
    import.meta.env.VITE_ACCEPT_JOB_URL ??
    "http://localhost:6003",
  VITE_CLOSE_CASE_URL:
    window.__env?.VITE_CLOSE_CASE_URL ??
    import.meta.env.VITE_CLOSE_CASE_URL ??
    "http://localhost:6004",
  VITE_RESCHEDULE_JOB_URL:
    window.__env?.VITE_RESCHEDULE_JOB_URL ??
    import.meta.env.VITE_RESCHEDULE_JOB_URL ??
    "http://localhost:6006",
};

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
  VITE_PROOF_ATOM_URL:
    window.__env?.VITE_PROOF_ATOM_URL ??
    import.meta.env.VITE_PROOF_ATOM_URL ??
    "http://localhost:5005",
  VITE_ALERT_ATOM_URL:
    window.__env?.VITE_ALERT_ATOM_URL ??
    import.meta.env.VITE_ALERT_ATOM_URL ??
    "http://localhost:5006",
  VITE_CONTRACTOR_ATOM_URL:
    window.__env?.VITE_CONTRACTOR_ATOM_URL ??
    import.meta.env.VITE_CONTRACTOR_ATOM_URL ??
    "http://localhost:5009",
  VITE_OPEN_CASE_URL:
    window.__env?.VITE_OPEN_CASE_URL ??
    import.meta.env.VITE_OPEN_CASE_URL ??
    "http://localhost:6001",
  VITE_HANDLE_BREACH_URL:
    window.__env?.VITE_HANDLE_BREACH_URL ??
    import.meta.env.VITE_HANDLE_BREACH_URL ??
    "http://localhost:6005",
  VITE_GOOGLE_MAPS_API_KEY:
    window.__env?.VITE_GOOGLE_MAPS_API_KEY ??
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY ??
    "",
};

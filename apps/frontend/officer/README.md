# TownOps Officer Frontend

The operational dashboard for town council officers. Officers can open new cases, monitor the Kanban board, view case details and audit trails, and manually escalate SLA breaches.

Runs at `http://localhost:3001` (docker-compose) or `http://localhost:5173` (dev server).

## 🛠️ Tech Stack

- **Routing:** `@tanstack/react-router` — type-safe file-based routing
- **Data Fetching:** `@tanstack/react-query`
- **Forms:** `@tanstack/react-form` + `@tanstack/zod-form-adapter`
- **Validation:** `zod`
- **Styling:** Tailwind v4 + shadcn/ui
- **Testing:** `vitest` + `jsdom`

## 🚀 Development

```bash
# From monorepo root
pnpm run dev --filter "@townops/officer-frontend"

# Or from this directory
pnpm run dev
```

## 🌍 Environment Variables

Create a `.env` file in this directory:

```env
VITE_APP_URL=http://localhost:3001
VITE_AUTH_URL=http://localhost:5001
VITE_CASE_ATOM_URL=http://localhost:5005
VITE_ASSIGNMENT_ATOM_URL=http://localhost:5004
VITE_APPOINTMENT_ATOM_URL=http://localhost:5003
VITE_PROOF_ATOM_URL=http://localhost:5007
VITE_ALERT_ATOM_URL=http://localhost:5002
VITE_OPEN_CASE_URL=http://localhost:6001
VITE_HANDLE_BREACH_URL=http://localhost:6005
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key
```

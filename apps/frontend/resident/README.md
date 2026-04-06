# TownOps Resident Frontend

The self-service portal for residents. Residents receive a magic-link email when their job is rescheduled and use this app to select a new appointment time slot.

Runs at `http://localhost:3003` (docker-compose) or `http://localhost:5173` (dev server).

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
pnpm run dev --filter "@townops/resident-frontend"

# Or from this directory
pnpm run dev
```

## 🌍 Environment Variables

Create a `.env` file in this directory:

```env
VITE_APP_URL=http://localhost:3003
VITE_AUTH_URL=http://localhost:5001
VITE_RESCHEDULE_JOB_URL=http://localhost:6006
```

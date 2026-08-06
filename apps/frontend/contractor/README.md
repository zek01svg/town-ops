# TownOps Contractor Frontend

The operational dashboard for Contractors. Contractors can view assigned work
and accept their current Allocation Attempt with a future Appointment through
the Gateway. Proof upload and completion use the Gateway's Temporal Case
routes; No Access retains its existing flow.

Runs at `http://localhost:3002` (docker-compose) or `http://localhost:5173` (dev server).

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
pnpm run dev --filter "@townops/contractor-frontend"

# Or from this directory
pnpm run dev
```

## 🌍 Environment Variables

Create a `.env` file in this directory:

```env
VITE_APP_URL=http://localhost:3002
VITE_AUTH_URL=http://localhost:5001
VITE_GATEWAY_URL=http://localhost:6010
VITE_GOOGLE_MAPS_API_KEY=your-google-maps-api-key
```

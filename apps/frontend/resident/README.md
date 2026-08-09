# TownOps Resident frontend

The Resident portal provides Case and Appointment interactions through Gateway.

## Local development

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/resident-frontend dev
pnpm --filter @townops/resident-frontend test
pnpm --filter @townops/resident-frontend build
```

The Compose application is available at `http://localhost:3003`; Vite uses
its normal local development server.

## Configuration

Browser API calls, including authentication, use `VITE_GATEWAY_URL` (locally
`http://localhost:6010`). Do not configure direct Auth or atom URLs.

# TownOps Contractor frontend

The Contractor dashboard views assigned Case work, records attendance, submits Proof Items, and completes work through Gateway.

## Local development

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/contractor-frontend dev
pnpm --filter @townops/contractor-frontend test
pnpm --filter @townops/contractor-frontend build
```

The Compose application is available at `http://localhost:3002`; Vite uses
its normal local development server.

## Configuration

Browser API calls, including authentication, use `VITE_GATEWAY_URL` (locally
`http://localhost:6010`). Do not configure direct Auth or atom URLs.

Map pages also require `VITE_GOOGLE_MAPS_API_KEY`.

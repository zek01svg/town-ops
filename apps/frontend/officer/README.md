# TownOps Officer frontend

The Officer dashboard opens and supervises Cases, resolves Officer Attention, and uses Gateway for all browser operations.

## Local development

Run these commands from the monorepo root:

```bash
pnpm --filter @townops/officer-frontend dev
pnpm --filter @townops/officer-frontend test
pnpm --filter @townops/officer-frontend build
```

The Compose application is available at `http://localhost:3001`; Vite uses
its normal local development server.

## Configuration

Browser API calls, including authentication, use `VITE_GATEWAY_URL` (locally
`http://localhost:6010`). Do not configure direct Auth or atom URLs.

Map pages also require `VITE_GOOGLE_MAPS_API_KEY`.

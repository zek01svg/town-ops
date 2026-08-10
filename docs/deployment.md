# Deployment and local setup

`docker-compose.yml` is the source of truth for local services, ports, and
container configuration. The supported production cutover is a fresh reset;
do not attempt to migrate the retired topology in place.

## Prerequisites

- Bun 1.3 or newer
- pnpm 11 or newer
- Docker Compose for the full stack and integration tests

## Local stack

Copy the checked-in environment examples without committing the resulting
`.env` files, then install dependencies:

```bash
pnpm install --frozen-lockfile
```

Apply generated migrations for every atom before starting a local stack:

```bash
pnpm --filter @townops/auth-atom db:migrate
pnpm --filter @townops/alert-atom db:migrate
pnpm --filter @townops/appointment-atom db:migrate
pnpm --filter @townops/assignment-atom db:migrate
pnpm --filter @townops/case-atom db:migrate
pnpm --filter @townops/contractor-atom db:migrate
pnpm --filter @townops/metrics-atom db:migrate
pnpm --filter @townops/proof-atom db:migrate
pnpm --filter @townops/resident-atom db:migrate
```

Start the full local topology:

```bash
docker compose up --build
```

Gateway health is `http://localhost:6010/health`; Temporal UI is
`http://localhost:8080`. A Worker has no public HTTP port.

## Configuration boundaries

Gateway connects to Temporal, validates JWTs through Auth JWKS, proxies public
`/api/auth/*`, and receives `WORKER_SERVICE_TOKEN` for trusted atom access.
Worker receives the same token and atom URLs for its Activities. Internal atom
routes require that token.

All three frontend applications use `VITE_GATEWAY_URL` (locally
`http://localhost:6010`) for browser API calls. Do not configure atom or
retired-service URLs in a frontend.

## Operating failures

Temporal UI shows Workflow Task and replay failures. Gateway returns
`504 WORKFLOW_UPDATE_PENDING` when an accepted Update outlives its wait,
`503 TEMPORAL_UNAVAILABLE` when Temporal cannot be reached, and
`500 WORKFLOW_UPDATE_FAILED` for other Update failures. A pending Update is
not a lost write; retry the request with its idempotency key.

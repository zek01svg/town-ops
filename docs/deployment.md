# Deployment and local setup

The checked-in `docker-compose.yml` is the source of truth for local service
ports and container environment variables.

## Prerequisites

- Bun >= 1.3
- pnpm >= 11
- Docker Compose for the complete local stack and integration tests

## Install dependencies

```bash
pnpm install --frozen-lockfile
```

## Environment variables

Copy a service's `.env.example` when it has one. Never commit `.env` files.

### Atoms

All atoms need `PORT` and `DATABASE_URL`. The Worker-authenticated atoms also
need the same `WORKER_SERVICE_TOKEN` value as the Worker.

| Service     | Port | Additional required configuration                                                                                  |
| :---------- | ---: | :----------------------------------------------------------------------------------------------------------------- |
| Auth        | 5001 | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`                                                                            |
| Alert       | 5002 | `RABBITMQ_URL`, `RESEND_API_KEY`                                                                                   |
| Appointment | 5003 | `WORKER_SERVICE_TOKEN`                                                                                             |
| Assignment  | 5004 | `JWKS_URI`, `WORKER_SERVICE_TOKEN`                                                                                 |
| Case        | 5005 | `WORKER_SERVICE_TOKEN`                                                                                             |
| Metrics     | 5006 | `WORKER_SERVICE_TOKEN`                                                                                             |
| Proof       | 5007 | `DATABASE_URL`, `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `WORKER_SERVICE_TOKEN` |
| Resident    | 5008 | `WORKER_SERVICE_TOKEN`                                                                                             |
| Contractor  | 5009 | `WORKER_SERVICE_TOKEN`                                                                                             |

### Temporal orchestration

| Service     | Port | Required configuration                                                                                                                                                 |
| :---------- | ---: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway     | 6010 | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `JWKS_URI`, `WORKER_SERVICE_TOKEN`, and the Case, Resident, Auth, Assignment, Appointment, and `PROOF_ATOM_URL` atom URLs    |
| Worker      |    — | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_SERVICE_TOKEN`, and the Resident, Case, Contractor, Metrics, Assignment, Appointment, and `PROOF_ATOM_URL` atom URLs |
| Temporal    | 7233 | Managed by Compose                                                                                                                                                     |
| Temporal UI | 8080 | Managed by Compose                                                                                                                                                     |

For Compose, the Gateway uses `http://auth-atom:5001/api/auth/jwks`,
`http://case-atom:5005`, `http://resident-atom:5008`,
`http://assignment-atom:5004`, `http://appointment-atom:5003`, and
`http://proof-atom:5007`.

### Frontends

Existing screens still read several atom and composite URLs directly; the
Contractor's allocation-acceptance request uses the Gateway.

| Variable                    | Local value             |
| :-------------------------- | :---------------------- |
| `VITE_AUTH_URL`             | `http://localhost:5001` |
| `VITE_GATEWAY_URL`          | `http://localhost:6010` |
| `VITE_CASE_ATOM_URL`        | `http://localhost:5005` |
| `VITE_ASSIGNMENT_ATOM_URL`  | `http://localhost:5004` |
| `VITE_APPOINTMENT_ATOM_URL` | `http://localhost:5003` |
| `VITE_ALERT_ATOM_URL`       | `http://localhost:5002` |
| `VITE_PROOF_ATOM_URL`       | `http://localhost:5007` |
| `VITE_ACCEPT_JOB_URL`       | `http://localhost:6003` |
| `VITE_RESCHEDULE_JOB_URL`   | `http://localhost:6006` |
| `VITE_HANDLE_NO_ACCESS_URL` | `http://localhost:6007` |

## Database setup

Apply each atom's schema before running locally. Appointment uses `db:apply`
because its slot-claim exclusion constraint is applied outside Drizzle's normal
schema push.

```bash
pnpm --filter @townops/case-atom db:push
pnpm --filter @townops/resident-atom db:push
pnpm --filter @townops/assignment-atom db:push
pnpm --filter @townops/appointment-atom db:apply
pnpm --filter @townops/proof-atom db:push
pnpm --filter @townops/alert-atom db:push
pnpm --filter @townops/metrics-atom db:push
pnpm --filter @townops/auth-atom db:push
pnpm --filter @townops/auth-atom auth:push
```

## Start and verify

```bash
pnpm dev
# or start the complete local stack
docker compose up --build
```

- Gateway health: `GET http://localhost:6010/health`
- Temporal UI: `http://localhost:8080`
- Service health: `GET http://localhost:<port>/health`

## CI/CD

GitHub Actions workflows are in `.github/workflows/`:

- `deploy.yml` — production deployment
- `security-checks.yml` — dependency audits and secret scanning

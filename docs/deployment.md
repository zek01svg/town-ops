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

| Service     | Port | Required configuration                                                                                                                                                                                                      |
| :---------- | ---: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway     | 6010 | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `JWKS_URI`, `WORKER_SERVICE_TOKEN`, optional `GATEWAY_UPDATE_TIMEOUT_MS` (default `20000`), and the Case, Resident, Auth, Assignment, Appointment, and `PROOF_ATOM_URL` atom URLs |
| Worker      |    — | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `WORKER_SERVICE_TOKEN`, optional `BUILD_ID` (default `dev`), and the Resident, Case, Contractor, Metrics, Assignment, Appointment, and `PROOF_ATOM_URL` atom URLs                 |
| Temporal    | 7233 | Managed by Compose                                                                                                                                                                                                          |
| Temporal UI | 8080 | Managed by Compose                                                                                                                                                                                                          |

For Compose, the Gateway uses `http://auth-atom:5001/api/auth/jwks`,
`http://case-atom:5005`, `http://resident-atom:5008`,
`http://assignment-atom:5004`, `http://appointment-atom:5003`, and
`http://proof-atom:5007`.

### Worker Deployment versioning

`BUILD_ID` is the Worker's build identity, and it decides whether the Worker
runs versioned:

- **`dev` (the default) — unversioned.** `pnpm dev` and a plain
  `docker compose up` both land here. The Worker polls the unversioned pool and
  drains work immediately, with no promotion step.
- **A real git SHA — versioned.** The Worker joins the single Worker Deployment
  `townops-orchestration` with `AUTO_UPGRADE`, so in-flight Workflows move to
  the newest build. Because they cross builds, Workflow changes need patch
  markers — see [Temporal versioning](./temporal-versioning.md).

Compose passes `BUILD_ID` only as a Docker **build arg**, never as a runtime
environment variable, so the SHA an image reports is always the SHA it was built
from. Rebuilding is the only way to change it:

```bash
BUILD_ID=$(git rev-parse --short HEAD) docker compose up --build worker
```

Building a versioned Worker is only half the deploy. It registers its version
and polls, but the task queue does not route to it until that version is made
current for the deployment — `SetWorkerDeploymentCurrentVersion`
(`deploymentName: townops-orchestration`, `buildId: <sha>`), from the Temporal
UI's Deployments view or the `temporal` CLI. Until then the new Worker drains
nothing and Updates fall through to the Gateway's
`504 WORKFLOW_UPDATE_PENDING`.

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

Both leave `BUILD_ID` at `dev`, so the Worker runs unversioned and drains work
straight away. If you set a real `BUILD_ID`, the Worker becomes versioned and
will drain nothing until you promote that version to current for the
`townops-orchestration` deployment — see
[Worker Deployment versioning](#worker-deployment-versioning). The symptom of
skipping that step is every Case operation returning
`504 WORKFLOW_UPDATE_PENDING`.

- Gateway health: `GET http://localhost:6010/health`
- Temporal UI: `http://localhost:8080`
- Service health: `GET http://localhost:<port>/health`

## Observing orchestration failures

None of these four conditions fail silently. Where an operator sees each:

| Condition                | Where it surfaces                                                                                                                                                                                                                                                                                                                               |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow nondeterminism  | The Workflow Task fails and retries; the Temporal UI shows the Execution's pending Workflow Task with the failure. A fatal Worker run failure also logs `[worker] worker run failed` and exits non-zero.                                                                                                                                        |
| Replay failure           | Same path as nondeterminism — a failing Workflow Task on the Execution, plus the Worker's non-zero exit if the run itself dies.                                                                                                                                                                                                                 |
| Unhandled Update failure | Every Update route splits three ways: timeout → `504 WORKFLOW_UPDATE_PENDING`, Temporal unreachable → `503 TEMPORAL_UNAVAILABLE`, anything else → `500 WORKFLOW_UPDATE_FAILED` with `retryable: false`. A genuine failure is never reported as still-pending. The Execution's Update history in the Temporal UI carries the underlying failure. |
| Absent Worker pollers    | Nothing drains the task queue, so the Gateway's Update wait expires and it returns `504 WORKFLOW_UPDATE_PENDING` with `Retry-After: 2`. The task queue's Pollers tab in the Temporal UI is empty.                                                                                                                                               |

A 504 `WORKFLOW_UPDATE_PENDING` is not a lost write. The Gateway leaves the
accepted Update running and the client retries; `GATEWAY_UPDATE_TIMEOUT_MS`
tunes how long it waits first.

## CI/CD

GitHub Actions workflows are in `.github/workflows/`:

- `deploy.yml` — production deployment
- `security-checks.yml` — dependency audits and secret scanning

# TownOps: Estate Maintenance Management System

TownOps digitises HDB estate maintenance workflows — from case creation through contractor dispatch, job acceptance, SLA monitoring, and closure — into a structured, auditable lifecycle.

## Architecture

TownOps uses Temporal for durable Case orchestration:

- **Atoms** (`apps/atoms/`) — Data owners. Each atom owns exactly one domain schema, exposes a REST API, and never calls other services directly.
- **Gateway and Worker** (`apps/gateway/`, `apps/worker/`) — The Gateway is the browser API; the Worker runs Temporal Workflows and calls private atom routes with its service token.
- **Frontends** (`apps/frontend/`) — Role-specific React dashboards for Officers, Contractors, and Residents. They use the Gateway, not atom URLs.
- **Shared Packages** (`packages/`) — Cross-cutting utilities, UI components, and type definitions.

See [`docs/architecture.md`](docs/architecture.md) and [ADR 0001](docs/adr/0001-temporal-orchestration.md).

## Services

| Service                                 | Port |
| :-------------------------------------- | :--- |
| Auth atom                               | 5001 |
| Alert atom                              | 5002 |
| Appointment atom                        | 5003 |
| Assignment atom                         | 5004 |
| Case atom                               | 5005 |
| Performance Entry atom (`metrics-atom`) | 5006 |
| Proof atom                              | 5007 |
| Resident atom                           | 5008 |
| Contractor atom                         | 5009 |
| Gateway                                 | 6010 |
| Temporal                                | 7233 |
| Temporal UI                             | 8080 |
| Worker                                  | —    |
| Officer frontend                        | 3001 |
| Contractor frontend                     | 3002 |
| Resident frontend                       | 3003 |

See [`docs/service-map.md`](docs/service-map.md) for full details including routes and responsibilities.

## Getting Started

```bash
# Install dependencies
pnpm install

# Apply generated database migrations for each atom.
pnpm --filter @townops/case-atom db:migrate
pnpm --filter @townops/appointment-atom db:migrate
# ... repeat for every atom

# Start all services
pnpm run dev
```

See [`docs/deployment.md`](docs/deployment.md) for full local setup, environment variables, and seed scripts.

## Documentation

| Doc                                      | Description                                        |
| :--------------------------------------- | :------------------------------------------------- |
| [Architecture](docs/architecture.md)     | Atoms, Gateway/Worker, Temporal, and auth          |
| [Service Map](docs/service-map.md)       | Current Compose services and ports                 |
| [Event Flow](docs/event-flow.md)         | Temporal Case Workflow and Derived Effect delivery |
| [Case Lifecycle](docs/case-lifecycle.md) | Implemented allocation and appointment lifecycle   |
| [Deployment](docs/deployment.md)         | Local setup, env vars, seed data                   |
| [Tech Stack](docs/tech-stack.md)         | Framework and tooling choices                      |
| [ADRs](docs/adr/)                        | Accepted architecture decisions                    |
| [Agent guides](docs/agents/)             | Domain and tracker conventions                     |

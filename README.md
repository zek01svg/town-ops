# TownOps: Estate Maintenance Management System

TownOps digitises HDB estate maintenance workflows — from case creation through contractor dispatch, job acceptance, SLA monitoring, and closure — into a structured, auditable lifecycle.

## Architecture

Strictly layered services with Temporal-backed Case orchestration:

- **Atoms** (`apps/atoms/`) — Data owners. Each atom owns exactly one domain schema, exposes a REST API, and never calls other services directly.
- **Composites** (`apps/composites/`) — Stateless HTTP/AMQP orchestrators for existing flows.
- **Gateway and Worker** (`apps/gateway/`, `apps/worker/`) — Browser API and Temporal Worker for the current Case path.
- **Frontends** (`apps/frontend/`) — Role-specific React dashboards for officers, contractors, and residents.
- **Shared Packages** (`packages/`) — Cross-cutting utilities, UI components, and type definitions.

See [`docs/architecture.md`](docs/architecture.md) for the full design and messaging patterns.

## Services

| Service                    | Port |
| :------------------------- | :--- |
| Auth atom                  | 5001 |
| Alert atom                 | 5002 |
| Appointment atom           | 5003 |
| Assignment atom            | 5004 |
| Case atom                  | 5005 |
| Metrics atom               | 5006 |
| Proof atom                 | 5007 |
| Resident atom              | 5008 |
| Contractor atom            | 5009 |
| Open Case composite        | 6001 |
| Assign Job composite       | 6002 |
| Accept Job composite       | 6003 |
| Close Case composite       | 6004 |
| Handle Breach composite    | 6005 |
| Reschedule Job composite   | 6006 |
| Handle No Access composite | 6007 |
| Gateway                    | 6010 |
| Temporal                   | 7233 |
| Temporal UI                | 8080 |
| Worker                     | —    |
| Officer frontend           | 3001 |
| Contractor frontend        | 3002 |
| Resident frontend          | 3003 |

See [`docs/service-map.md`](docs/service-map.md) for full details including routes and responsibilities.

## Getting Started

```bash
# Install dependencies
pnpm install

# Apply database schemas (run per atom)
pnpm --filter @townops/case-atom db:push
pnpm --filter @townops/appointment-atom db:apply
# ... repeat for each remaining atom

# Start all services
pnpm run dev
```

See [`docs/deployment.md`](docs/deployment.md) for full local setup, environment variables, and seed scripts.

## Documentation

| Doc                                      | Description                                      |
| :--------------------------------------- | :----------------------------------------------- |
| [Architecture](docs/architecture.md)     | Atoms, Gateway/Worker, Temporal, and auth        |
| [Service Map](docs/service-map.md)       | Current Compose services and ports               |
| [Event Flow](docs/event-flow.md)         | Temporal Case path and existing AMQP flows       |
| [Case Lifecycle](docs/case-lifecycle.md) | Implemented allocation and appointment lifecycle |
| [Deployment](docs/deployment.md)         | Local setup, env vars, seed data                 |
| [Tech Stack](docs/tech-stack.md)         | Framework and tooling choices                    |

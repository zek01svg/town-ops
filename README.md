# 🏘️ TownOps: Estate Maintenance Management System

TownOps digitises HDB estate maintenance workflows — from case creation through contractor dispatch, job acceptance, SLA monitoring, and closure — into a structured, auditable lifecycle.

## 🏗️ Architecture

Strictly layered **Atomic/Composite** microservices pattern:

- **⚛️ Atoms** (`apps/atoms/`) — Data owners. Each atom owns exactly one domain schema, exposes a REST API, and never calls other services directly.
- **🧩 Composites** (`apps/composites/`) — Business orchestrators. Stateless services that coordinate multiple atoms via HTTP and publish AMQP events.
- **💻 Frontends** (`apps/frontend/`) — Role-specific React dashboards for officers, contractors, and residents.
- **📦 Shared Packages** (`packages/`) — Cross-cutting utilities, UI components, and type definitions.

See [`docs/architecture.md`](docs/architecture.md) for the full design and messaging patterns.

## ⚙️ Services

| Service                  | Port |
| :----------------------- | :--- |
| Case atom                | 5001 |
| Resident atom            | 5002 |
| Assignment atom          | 5003 |
| Appointment atom         | 5004 |
| Proof atom               | 5005 |
| Alert atom               | 5006 |
| Metrics atom             | 5007 |
| Auth atom                | 5008 |
| Open Case composite      | 6001 |
| Assign Job composite     | 6002 |
| Accept Job composite     | 6003 |
| Close Case composite     | 6004 |
| Handle Breach composite  | 6005 |
| Reschedule Job composite | 6006 |
| Contractor frontend      | 4000 |
| Officer frontend         | 4001 |

See [`docs/service-map.md`](docs/service-map.md) for full details including routes and responsibilities.

## 🚀 Getting Started

```bash
# Install dependencies
pnpm install

# Push database schemas (run per atom)
pnpm --filter @townops/case-atom db:push --force
# ... repeat for each atom

# Start all services
pnpm run dev
```

See [`docs/deployment.md`](docs/deployment.md) for full local setup, environment variables, and seed scripts.

## 📚 Documentation

| Doc                                      | Description                                     |
| :--------------------------------------- | :---------------------------------------------- |
| [Architecture](docs/architecture.md)     | Atomic/Composite pattern, messaging, auth       |
| [Service Map](docs/service-map.md)       | All services, ports, routes                     |
| [Event Flow](docs/event-flow.md)         | AMQP event topology and routing                 |
| [Case Lifecycle](docs/case-lifecycle.md) | Case/assignment state machines, SLA, proof flow |
| [Deployment](docs/deployment.md)         | Local setup, env vars, seed data                |
| [Tech Stack](docs/tech-stack.md)         | Framework and tooling choices                   |

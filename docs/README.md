# TownOps Documentation 📖

This folder records TownOps's active Case topology, lifecycle, and operating
guidance. Source code and service configuration remain authoritative for live
ports, variables, and commands.

## 🗂️ Table of Contents

| Document                                               | Description                                                                         |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------- |
| 🏗️ **[Architecture](./architecture.md)**               | Gateway, Temporal Worker, private atoms, and auth boundary.                         |
| 🗺️ **[Service Map](./service-map.md)**                 | Active services, ports, and responsibilities.                                       |
| ⚡ **[Event Flow](./event-flow.md)**                   | Durable Case Workflow and Derived Effect delivery.                                  |
| 🔄 **[Case Lifecycle](./case-lifecycle.md)**           | Case and assignment status state machines, SLA window, and proof/closure flow.      |
| 🚀 **[Deployment](./deployment.md)**                   | Local setup and DB migrations, plus the GCP apply, verify, and teardown runbook.    |
| 🧩 **[Temporal Versioning](./temporal-versioning.md)** | Worker Deployments, when a Workflow change needs a patch marker, and patch removal. |
| 🛠 **[Tech Stack](./tech-stack.md)**                    | Framework and tooling choices.                                                      |
| 📜 **[ADRs](./adr/)**                                  | Accepted architecture decisions.                                                    |
| 🤖 **[Agent guides](./agents/)**                       | Domain vocabulary and agent conventions.                                            |

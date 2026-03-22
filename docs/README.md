# TownOps Documentation 📖

This folder contains detailed specs regarding **TownOps** decoupled design patterns, message handlers, and service topology.

## 🗂️ Table of Contents

| Document                                 | Description                                                                                 |
| :--------------------------------------- | :------------------------------------------------------------------------------------------ |
| 🏗️ **[Architecture](./architecture.md)** | Covers the **Atomic/Composite** philosophy, RabbitMQ design patterns, and decoupling Rules. |
| 🗺️ **[Service Map](./service-map.md)**   | Full list of active microservice instances, port assignments, and static module paths.      |
| ⚡ **[Event Flow](./event-flow.md)**     | Details Pub/Sub streams handling eventual consistency triggers and SLA alerts.              |
| 🚀 **[Deployment](./deployment.md)**     | Notes on local environment setup triggers and container topologies.                         |

---

## 💡 Core Setup Breakdown

TownOps enforces strict isolation of execution nodes based on responsibilities:

- **Atoms (`/apps/atoms`)**: Agnostic data owners (Tech: Bun/Hono). Each Atom owns exactly one data schema and broadcasts alters using RabbitMQ streams.
- **Composites (`/apps/composites`)**: Business orchestrators (Tech: Python/FastAPI). Maintains stateless responses coordinating multiple HTTP Rest node boundaries.
- **Shared Nodes (`/packages`)**: Centralized static types bundles, styles components, and reusable utilities linked with automated Catalogs for version alignment.

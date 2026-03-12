# TownOps - Town Council Operations System

TownOps is an enterprise-grade maintenance management system built with a split Atomic/Composite microservices architecture.

## 🏗 Architecture Overview

We follow a strict **layered orchestration** pattern:
- **Atoms (Data):** Exclusive owners of their domain tables.
- **Composites (Process):** Orchestrators that coordinate multiple atoms via HTTP REST.
- **Messaging:** RabbitMQ events handle cross-service notifications and SLA timers.

## 🚀 Quickstart for Developers

### 1. Prerequisites
- **Docker Desktop** (for DB/MQ/Gateway)
- **Node.js 20+** & **pnpm**
- **Python 3.11+** & **uv**
- **VS Code** (with recommended extensions)

### 2. Infrastructure Setup
Spin up the core databases and message broker:
```bash
cd infrastructure
docker-compose up -d
```

### 3. Environment Config
Copy the example environment template:
```bash
cp .env.example .env
```
*Note: Beginners should start by editing the `.env` file to match their local setup.*

### 4. Running Services
We use **Turborepo** to manage the mono-repo.
```bash
pnpm install
pnpm dev
```

## 📂 Directory Map
- `/apps/atoms`: Data entities (PostgreSQL)
- `/apps/composites`: Business workflows (No Database)
- `/packages`: Shared UI components and types
- `/infrastructure`: Docker, Kong, and RabbitMQ configs
- `/tests/e2e`: Playwright system flows

## 🛠 Tech Stack
- **Frontend:** React 19, TS, TailwindCSS, TanStack Query
- **Backend:** FastAPI (Python), Node.js (TS)
- **Infra:** PostgreSQL, RabbitMQ (DLX), Kong Gateway, Docker

## 🤝 Contribution Rules
1. **Never** call an Atom from an Atom via HTTP. Use AMQP messaging.
2. **Never** bypass the Composite for a complex process.
3. **Always** format with `pnpm lint` before pushing.
4. **Secrets** belong in `.env`. Do not commit them.

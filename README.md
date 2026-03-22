# 🏢 TownOps: Enterprise Maintenance Management System

[![CI/CD](https://github.com/zek01svg/town-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/zek01svg/town-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-blue.svg)](https://nodejs.org/)
[![Python Version](https://img.shields.io/badge/python-%3E%3D3.11-blue.svg)](https://www.python.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10.0.0-orange.svg)](https://pnpm.io/)
[![uv](https://img.shields.io/badge/uv-%3E%3D0.5.0-purple.svg)](https://astral.sh/uv)

---

### 🌟 Value Proposition

**TownOps** is an enterprise-grade maintenance management system designed for high-concurrency municipal operations. It addresses the complexity of urban maintenance by decoupling data ownership from business processes through a strictly layered **Atomic/Composite** architecture. This ensures data integrity, horizontal scalability, and resilient asynchronous event handling.

---

## 📐 Architecture

TownOps follows a 3-tier microservices pattern to ensure separation of concerns and independent scalability.

```mermaid
graph TD
    subgraph Client_Layer [Client Layer]
        FE[React 19 Frontend]
    end

    subgraph Gateway_Layer [API Gateway]
        Kong[Kong Gateway]
    end

    subgraph Service_Layer [Orchestration Layer]
        subgraph Composites [Composite Services - Node/Bun/Hono]
            OC[Open Case]
            AJ[Assign Job]
            CC[Close Case]
        end

        subgraph Atoms [Atomic Services - Python/FastAPI or Bun/Hono]
            Case[Case Atom]
            Alert[Alert Atom]
            Res[Resident Atom]
            Attr[Assignment Atom]
        end
    end

    subgraph Infrastructure [Data & Messaging]
        DB[(PostgreSQL)]
        MQ[[RabbitMQ]]
        Cache[(Redis)]
    end

    FE -->|HTTP/REST| Kong
    Kong -->|HTTP/REST| Composites
    Composites -->|HTTP/REST| Atoms
    Atoms <-->|SQL/Drizzle| DB
    Atoms -.->|AMQP Events| MQ
    Composites -.->|Consume Events| MQ
```

> [!IMPORTANT]
> **Architectural Rule:** Atomic services own their data and never call other services via HTTP. All cross-service communication at the Atomic level MUST occur asynchronously via RabbitMQ.

---

## 🛠 Tech Stack

| Category         | Technology                           | Usage                                               |
| :--------------- | :----------------------------------- | :-------------------------------------------------- |
| **Language**     | TypeScript, Python 3.11+             | Dual-language codebase for performance & ergonomics |
| **Runtime**      | Node.js 20, Bun (Atoms), UV (Python) | High-performance execution environments             |
| **Frontend**     | React 19, Vite 6, TailwindCSS 4      | Modern, fast, and responsive user interfaces        |
| **Backend (TS)** | Hono, Bun                            | Atoms                                               |
| **Backend (PY)** | FastAPI, Pydantic                    | Composites                                          |
| **Database**     | PostgreSQL, Drizzle ORM              | Relational consistency with type-safe migrations    |
| **Messaging**    | RabbitMQ (AMQP)                      | Asynchronous event flows and SLA timers             |
| **Gateway**      | Kong Gateway                         | Centralized routing, auth, and rate limiting        |
| **CI/CD**        | GitHub Actions                       | Automated linting, testing, and deployment          |

---

## ⚙️ Environment Configuration

| Variable           | Description                      | Example                                  |
| :----------------- | :------------------------------- | :--------------------------------------- |
| `RABBITMQ_URL`     | URL for the message broker       | `amqp://guest:guest@localhost:5672`      |
| `DATABASE_URL`     | Connection string for PostgreSQL | `postgres://user:pass@localhost:5432/db` |
| `VITE_GATEWAY_URL` | External Gateway URL (Frontend)  | `http://localhost:8000`                  |
| `KONG_ADMIN_API`   | Management API for the Gateway   | `http://localhost:8001`                  |
| `CASE_PORT`        | Port for the Case Atomic Service | `5001`                                   |

> [!TIP]
> Use the provided `.env.example` as a template for your local `.env` file.

---

## 🧪 Testing & Observability

- **Unit Testing**:
  - Python: `pytest`
  - JavaScript/TypeScript: `vitest`
- **E2E Testing**: Playwright handles cross-service system flows.
- **Linting & Formatting**:
  - `Ruff` for Python.
  - `ESLint` + `Prettier` for TypeScript/React.
- **Observability**: Error tracking via **Sentry** and centralized logging.

---

## 🚀 Getting Started

### 1. Initial Setup

Install the necessary workspace managers and dependencies.

```bash
# Install pnpm (if not already installed)
npm install -g pnpm

# Install JS/TS dependencies
pnpm install

# Setup Python environment and dependencies
uv sync
```

### 2. Infrastructure

Launch the database, gateway, and message broker.

```bash
cd infrastructure
docker-compose up -d
```

### 3. Database Migrations

Initialize your schemas using Drizzle (for individual atoms).

```bash
cd apps/atoms/case
pnpm db:push
```

### 4. Development

Start the local development server for all services.

```bash
pnpm dev
```

---

## 📂 Project Structure

```text
.
├── apps/                    # Microservices
│   ├── atoms/               # Data-owning services (Python/FastAPI)
│   │   ├── alert/           # Incident notifications
│   │   ├── case/            # Core maintenance records
│   │   └── ...              # 7 atomic services in total
│   ├── composites/          # Process orchestrators (TS/Hono)
│   │   ├── open-case/       # Orchestrates case creation
│   │   └── ...              # 6 composite services in total
│   └── frontend/            # React 19 / Vite Application
├── packages/                # Shared internal libraries
│   ├── shared-types/        # Shared TypeScript definitions
│   ├── shared-python/       # Shared Python utilities
│   └── ui-core/             # Centralized design system
├── tooling/                 # Shared configuration (ESLint, Ruff, Prettier)
├── infrastructure/          # Docker & Terraform configuration
└── tests/                   # E2E and Integration test suites
```

---

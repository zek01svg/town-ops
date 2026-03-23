# 🤝 Handle Breach Composite

A backend orchestrator composite dedicated to handling an SLA breach by consuming `SLA_Breached` events from RabbitMQ, re-querying for a backup worker, updating the Assignment and Case status to `ESCALATED`, recording a penalty, and publishing an alert.

---

## 🚀 **Tech Stack**

- **Runtime**: [Python 3.14+](https://www.python.org/)
- **Package Manager**: [uv](https://github.com/astral-sh/uv)
- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with variables or copy from `.env.example`:

```env
PORT=6005
RABBITMQ_URL=amqp://guest:guest@localhost:5672
ASSIGNMENT_ATOM_URL=http://localhost:8001
CASE_ATOM_URL=http://localhost:8002
METRICS_ATOM_URL=http://localhost:8003
OUTSYSTEMS_URL=http://localhost:8004
```

### 2. Run Locally (via uv)

```bash
uv sync
uv run uvicorn src.main:app --reload --port 6005
```

### 3. Run in Docker 🐳

To package and spin up with absolute workspace context reference:

```bash
# Build from Workspace Root!
docker build -f apps/composites/handle-breach/Dockerfile -t handle-breach-composite .

# Run Container
docker run --env-file .env -p 6005:6005 handle-breach-composite
```

---

## 📂 **Folder Layout**

- `src/main.py`: Main entrypoint for FastAPI and background task lifespan loop
- `src/worker.py`: Background consumer worker implementation consuming `sla.breached`
- `src/router.py`: Optional REST API endpoint for manual trigger hooks
- `src/clients.py`: Client wrappers connecting downstream atom modules
- `src/config.py`: Environment configuration settings
- `tests/`: Integration and unit test suite

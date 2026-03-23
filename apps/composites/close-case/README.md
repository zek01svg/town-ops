# 🤝 Close Case Composite

A backend orchestrator composite dedicated to closing a case by storing proof items, updating the Case status to `CLOSED`, and emitting a `Job_Done` event to RabbitMQ.

---

## 🚀 **Tech Stack**

- **Runtime**: [Python 3.14](https://www.python.org/)
- **Package Manager**: [uv](https://github.com/astral-sh/uv)
- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with variables or copy from `.env.example`:

```env
PORT=6004
CASE_SERVICE_URL=http://localhost:8000
PROOF_SERVICE_URL=http://localhost:8000
RABBITMQ_URL=amqp://guest:guest@localhost:5672
```

### 2. Run Locally (via uv)

```bash
uv sync
uv run uvicorn src.app:app --reload --port 6004
```

### 3. Run in Docker 🐳

To package and spin up with absolute workspace context reference:

```bash
# Build from Workspace Root!
docker build -f apps/composites/close-case/Dockerfile -t close-case-composite .

# Run Container
docker run --env-file .env -p 6004:6004 close-case-composite
```

---

## 📂 **Folder Layout**

- `src/app.py`: Main entrypoint for FastAPI and route implementations
- `src/case_client.py`: Client wrapper to interact with Case Service
- `src/proof_client.py`: Client wrapper to interact with Proof Service
- `src/schemas.py`: Pydantic request/response models
- `src/config.py`: Environment configuration settings
- `tests/`: Integration and unit test suite

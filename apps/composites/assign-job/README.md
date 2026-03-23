# 🤝 Assign Job Composite

A backend orchestrator composite dedicated to assigning jobs on top of downstream atoms and publishing to RabbitMQ.

---

## 🚀 **Tech Stack**

- **Runtime**: [Python 3.12+](https://www.python.org/)
- **Package Manager**: [uv](https://github.com/astral-sh/uv)
- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)
- **Messaging**: [aio-pika](https://github.com/aio-pika/aio-pika) (RabbitMQ)

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
PORT=6002
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# Downstream URL templates
ASSIGNMENT_URL=http://localhost:5003
CONTRACTOR_API_URL=http://localhost:5004
METRICS_URL=http://localhost:5005
```

### 2. Run Locally (via uv)

```bash
uv sync
uv run uvicorn src.main:app --reload --port 6002
```

### 3. Run in Docker 🐳

To package and spin up with absolute context reference:

```bash
# Build from Workspace Root!
docker build -f apps/composites/assign-job/Dockerfile -t assign-job-composite .

# Run Container
docker run --env-file .env -p 6002:6002 assign-job-composite
```

---

## 📂 **Folder Layout**

- `src/main.py`: Main entrypoint for FastAPI
- `src/services.py`: Integration and domain logic with downstream services
- `src/publisher.py`: RabbitMQ event publishing utilities
- `src/consumer.py`: Background consumer worker implementation

# 📁 Assignment Atom

A backend microservice (Atom) dedicated strictly to creating, updating, and querying municipal case assignments. It acts as a raw data backplane layer constructed using **FastAPI** and **SQLModel** with native OpenTelemetry instrumentation.

---

## 🚀 **Tech Stack**

- **Runtime**: [Python](https://www.python.org/)
- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)
- **OpenAPI & Docs**: [FastAPI](https://fastapi.tiangolo.com/advanced/openapi/)
- **Database ORM**: [SQLModel](https://sqlmodel.tiangolo.com/)
- **Logging**: [Structlog](https://www.structlog.org/en/stable/)
- **Testing**: [Pytest](https://docs.pytest.org/en/stable/)

---

## 📖 **API Documentation**

The API documentation is fully automated via OpenAPI specifications.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:5001/scalar`
- **OpenAPI Spec (.json)**: `http://localhost:5001/openapi`

---

## 💻 **Development Commands**

| Command                                                             | Description                                   |
| :------------------------------------------------------------------ | :-------------------------------------------- |
| `uv run uvicorn src.main:app --reload --port 5003 --host 127.0.0.1` | Starts development server with hot reloading. |
| `uv run uvicorn src.main:app --port 5003 --host 127.0.0.1`          | Starts production server.                     |

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
DATABASE_URL=postgres://user:password@localhost:5432/townops
PORT=5001
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### 2. Run Locally

```bash
uv sync
uv run uvicorn src.main:app --reload --port 5003 --host 127.0.0.1
```

### 3. Run in Docker 🐳

To package and spin up the optimized docker runtime:

```bash
# 1. Build Single-Stage Image from the workspace root
docker build -t assignment-atom . -f apps/atoms/assignment/Dockerfile

# 2. Run Container with absolute reference port mapping
docker run --env-file .env -p 5003:5003 assignment-atom
```

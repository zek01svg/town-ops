# 📁 Reschedule Job Composite

A backend microservice (Composite) dedicated strictly to rescheduling jobs. It acts as an orchestrator built using **FastAPI**.

---

## 🚀 **Tech Stack**

- **Framework**: [FastAPI](https://fastapi.tiangolo.com/)
- **OpenAPI & Docs**: [scalar-fastapi](https://scalar.com/)
- **Logging**: [structlog](https://structlog.readthedocs.io/)
- **Testing**: [Pytest](https://pytest.org/)
- **Package Manager**: [uv](https://github.com/astral-sh/uv)

---

## 📖 **API Documentation**

The API documentation is fully automated via Scalar.
Once the server is running, visit:

- **Dashboard (Scalar)**: `http://localhost:6006/docs`
- **OpenAPI Spec (.json)**: `http://localhost:6006/openapi.json`

---

## 💻 **Development Commands**

Running from the **Workspace Root**:

| Command                                        | Description                                                |
| :--------------------------------------------- | :--------------------------------------------------------- |
| `uv run uvicorn src.main:app --reload`         | Run the FastAPI server locally from the service directory. |
| `uv run pytest apps/composites/reschedule-job` | Executes test and validation verification suite.           |

---

## 🛠️ **Getting Started & Execution**

### 1. Environment Setup

Create a `.env` file in this directory with the following variables:

```env
RESCHEDULE_JOB_PORT=6006
RESIDENT_URL=http://localhost:5002
APPOINTMENT_URL=http://localhost:5004
CASE_URL=http://localhost:5001
```

### 2. Run Locally

Navigate to the project root and run:

```bash
uv sync
uv run uvicorn apps.composites.reschedule_job.src.main:app --host 127.0.0.1 --port 6006
```

### 3. Run in Docker 🐳

To package and spin up the container, execute from the **Workspace Root**:

```bash
# 1. Build Multi-Stage Image
docker build -f apps/composites/reschedule-job/Dockerfile -t reschedule-job-composite .

# 2. Run Container with absolute reference port mapping
docker run --env-file .env -p 6006:6006 reschedule-job-composite
```

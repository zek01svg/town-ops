# 🤝 Accept Job Composite

A backend orchestrator composite dedicated to accepting a job by updating Assignment and Case statuses and creating an Appointment block.

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
PORT=6003
APPOINTMENT_SERVICE_URL=http://localhost:5004
ASSIGNMENT_SERVICE_URL=http://localhost:5003
CASE_SERVICE_URL=http://localhost:5001
```

### 2. Run Locally (via uv)

```bash
uv sync
uv run uvicorn src.main:app --reload --port 6003
```

### 3. Run in Docker 🐳

To package and spin up with absolute context reference:

```bash
# Build from Workspace Root!
docker build -f apps/composites/accept-job/Dockerfile -t accept-job-composite .

# Run Container
docker run --env-file .env -p 6003:6003 accept-job-composite
```

---

## 📂 **Folder Layout**

- `src/main.py`: Main entrypoint for FastAPI
- `src/router.py`: Composite endpoints implementation
- `src/clients.py`: Microservice HTTP clients
- `src/schemas.py`: Pydantic request/response models
- `src/config.py`: Environment configuration settings

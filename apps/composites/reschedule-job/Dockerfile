# note: build this container from the workspace root
FROM python:3.14-slim

WORKDIR /app

# 1. Install system dependencies if any, then installer
RUN pip install uv

# 2. Copy the full workspace context (monorepo support)
COPY pyproject.toml uv.lock ./
COPY packages/shared-python /app/packages/shared-python
COPY apps/composites/reschedule-job /app/apps/composites/reschedule-job

# 3. Navigate into service directory and install prod deps only
WORKDIR /app/apps/composites/reschedule-job
RUN uv sync --no-dev

EXPOSE 6006

# 4. Run prod server
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "6006"]

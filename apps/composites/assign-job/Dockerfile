# note: build this container from the workspace root
FROM python:3.14-slim

WORKDIR /app

# 1. Install system dependencies if any, then installer
RUN pip install uv

# 2. Copy the full workspace context (monorepo support)
COPY pyproject.toml uv.lock ./
COPY packages/shared-python /app/packages/shared-python
COPY apps/composites/assign-job /app/apps/composites/assign-job

# 3. Navigate into service directory and install prod deps only
WORKDIR /app/apps/composites/assign-job
RUN uv sync --no-dev

EXPOSE 6002

# 4. Run prod server
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", "6002"]

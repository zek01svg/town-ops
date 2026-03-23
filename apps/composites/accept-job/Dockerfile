# note: build this container from the workspace root
FROM python:3.14-slim

WORKDIR /app

# 1. Install system dependencies if any, then installer
RUN pip install uv

# 2. Copy the full workspace context (monorepo support)
COPY pyproject.toml uv.lock ./
COPY packages/shared-python /app/packages/shared-python
COPY apps/composites/accept-job /app/apps/composites/accept-job

# 3. Navigate into service directory and install prod deps only
WORKDIR /app/apps/composites/accept-job
RUN uv sync --no-dev

# 4. Copy source code
COPY . .

EXPOSE 6003

# 5. Run prod server
CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", "6003"]

FROM python:3.14-slim

# Install uv for fast dependency resolution inside the container
RUN pip install uv
WORKDIR /app

# Copy workspace-level tooling so uv can resolve the shared package
COPY pyproject.toml uv.lock* ./

# Copy the shared package
COPY packages/shared-python ./packages/shared-python

# Copy this service
COPY apps/composites/close-case ./apps/composites/close-case

# Sync only this service's dependencies (no dev extras)
RUN uv sync --package townops-close-case --no-dev

WORKDIR /app/apps/composites/close-case

ENV PYTHONPATH=/app/apps/composites/close-case

EXPOSE 6004

CMD ["uv", "run", "--package", "townops-close-case", "uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "6004"]

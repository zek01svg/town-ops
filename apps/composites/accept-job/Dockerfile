FROM python:3.14-slim

# Install uv
RUN pip install uv

WORKDIR /app

# Copy workspace dependency manifests
COPY pyproject.toml ./
COPY ../../packages/shared-python ./packages/shared-python

# Install dependencies (no dev extras)
RUN uv sync --no-dev

# Copy source
COPY src/ ./src/

EXPOSE 6003

CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "6003"]

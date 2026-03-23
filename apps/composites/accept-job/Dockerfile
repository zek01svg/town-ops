FROM python:3.14-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy workspace dependency manifests
COPY pyproject.toml ./
COPY ../../packages/shared-python ./packages/shared-python

# Install dependencies (no dev extras)
RUN uv pip install --system -r pyproject.toml

# Copy source
COPY src/ ./src/

EXPOSE 6003

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "6003"]

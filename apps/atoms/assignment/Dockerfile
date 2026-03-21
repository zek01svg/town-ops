FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml .
RUN uv sync --frozen --no-dev

COPY src/ ./src/

EXPOSE 5003

CMD ["uv", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "5003"]

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from townops_shared.utils.observability import setup_logging, setup_tracing

from .consumer import start_consumer


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
  setup_logging()
  setup_tracing("assign-job")

  consumer_task = asyncio.create_task(start_consumer())
  try:
    yield
  finally:
    consumer_task.cancel()
    with suppress(asyncio.CancelledError):
      await consumer_task


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def get_health() -> dict[str, str]:
  return {"status": "ok"}

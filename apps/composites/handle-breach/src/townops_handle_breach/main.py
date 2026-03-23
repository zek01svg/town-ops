import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .router import router as breach_router
from .worker import start_worker

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001, ANN201
  # Start the AMQP consumer in the background
  worker_task = asyncio.create_task(start_worker())

  def on_task_done(task: asyncio.Task) -> None:
    try:
      task.result()
    except asyncio.CancelledError:
      pass
    except Exception:
      logger.exception("AMQP Background Worker crashed unexpectedly")

  worker_task.add_done_callback(on_task_done)
  yield
  worker_task.cancel()


app = FastAPI(title="TownOps Handle Breach Composite", lifespan=lifespan)

app.include_router(breach_router)


@app.get("/health")
async def health_check() -> dict[str, str]:
  return {"status": "ok"}

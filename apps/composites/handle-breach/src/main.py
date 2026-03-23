import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from townops_shared.utils.http import HttpClient
from townops_shared.utils.rabbitmq import RabbitMQClient

from .router import router as breach_router
from .worker import start_worker

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN201
  app.state.http_client = HttpClient().client
  app.state.rabbitmq = RabbitMQClient()
  await app.state.rabbitmq.connect()

  # Start the AMQP consumer in the background
  worker_task = asyncio.create_task(
    start_worker(app.state.rabbitmq, app.state.http_client)
  )

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
  await app.state.rabbitmq.disconnect()
  await app.state.http_client.aclose()


app = FastAPI(title="TownOps Handle Breach Composite", lifespan=lifespan)

app.include_router(breach_router)


@app.get("/health")
async def health_check() -> dict[str, str]:
  return {"status": "ok"}

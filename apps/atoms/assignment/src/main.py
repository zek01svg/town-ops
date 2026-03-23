from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from townops_shared.utils.observability import setup_logging, setup_tracing

from .database import init_db
from .routes import router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
  setup_logging()
  setup_tracing("assignment-service")
  init_db()
  yield


app = FastAPI(lifespan=lifespan)
app.include_router(router)

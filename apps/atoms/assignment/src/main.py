from contextlib import asynccontextmanager

from fastapi import FastAPI
from utils.database import init_db
from utils.observability import setup_logging, setup_tracing

from .routes import router


@asynccontextmanager
async def lifespan(_app: FastAPI):
  setup_logging()
  setup_tracing("assignment-service")
  init_db()
  yield


app = FastAPI(lifespan=lifespan)
app.include_router(router)

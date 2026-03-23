from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from townops_shared.utils.http import HttpClient
from townops_shared.utils.observability import setup_logging, setup_tracing

from .config import get_settings
from .router import router

setup_logging()
setup_tracing("accept-job")


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
  settings = get_settings()
  logger.info(
    "accept-job: starting up | ASSIGNMENT=%s CASE=%s APPOINTMENT=%s",
    settings.ASSIGNMENT_SERVICE_URL,
    settings.CASE_SERVICE_URL,
    settings.APPOINTMENT_SERVICE_URL,
  )
  app.state.http_client = HttpClient().client
  yield
  await app.state.http_client.aclose()
  logger.info("accept-job: shutdown complete")


# ─── Application ──────────────────────────────────────────────────────────────

app = FastAPI(
  title="accept-job Composite Service",
  version="1.0.0",
  description=(
    "Stateless orchestrator: accepts a contractor job by updating the Assignment "
    "and Case statuses, then creating an Appointment schedule block."
  ),
  lifespan=lifespan,
)

# CORS — allow React frontend (and API gateway) to call this service
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
)

app.include_router(router, prefix="/jobs", tags=["jobs"])


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
  return {"status": "healthy"}

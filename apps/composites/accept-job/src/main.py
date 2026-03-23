"""
FastAPI application entry point for the accept-job composite service.

Lifecycle:
  - Creates a single shared httpx.AsyncClient on startup.
  - Closes it cleanly on shutdown.

Middleware:
  - CORSMiddleware allows all origins (required for React frontend).

Observability:
  - Uses townops_shared structlog/OTEL setup where available.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .router import router

logger = logging.getLogger(__name__)


# ─── Attempt to use shared observability ─────────────────────────────────────
try:
    from townops_shared.utils.observability import setup_logging, setup_tracing

    setup_logging()
    setup_tracing("accept-job")
except ImportError:
    logging.basicConfig(level=logging.INFO)
    logger.warning("townops_shared observability not available; using stdlib logger")


# ─── Lifespan ─────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = get_settings()
    logger.info(
        "accept-job: starting up | ASSIGNMENT=%s CASE=%s APPOINTMENT=%s",
        settings.ASSIGNMENT_SERVICE_URL,
        settings.CASE_SERVICE_URL,
        settings.APPOINTMENT_SERVICE_URL,
    )
    # Create one shared AsyncClient for the lifetime of the application
    async with httpx.AsyncClient(timeout=30.0) as client:
        app.state.http_client = client
        yield
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

import logging
import os
import sys
from typing import Any

import structlog
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def add_otel_trace_id(
  _logger: Any,  # noqa: ANN401
  _method_name: str,
  event_dict: dict[str, Any],
) -> dict[str, Any]:
  """
  Processor to add OpenTelemetry trace_id and span_id to structlog events.
  """
  span = trace.get_current_span()
  if span and span.get_span_context().is_valid:
    ctx = span.get_span_context()
    event_dict["trace_id"] = format(ctx.trace_id, "032x")
    event_dict["span_id"] = format(ctx.span_id, "016x")
  return event_dict


def setup_logging() -> None:
  """
  Configures structlog to work with standard logging and OpenTelemetry.
  """
  env = os.getenv("ENV", "development")
  log_level = os.getenv("LOG_LEVEL", "INFO").upper()

  shared_processors = [
    structlog.contextvars.merge_contextvars,
    structlog.processors.add_log_level,
    structlog.dev.set_exc_info,
    structlog.processors.TimeStamper(fmt="iso"),
    add_otel_trace_id,
  ]

  structlog.configure(
    processors=[
      *shared_processors,
      structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
  )

  formatter = structlog.stdlib.ProcessorFormatter(
    foreign_pre_chain=shared_processors,
    processors=[
      structlog.stdlib.ProcessorFormatter.remove_processors_meta,
      structlog.processors.JSONRenderer()
      if env == "production"
      else structlog.dev.ConsoleRenderer(),
    ],
  )

  handler = logging.StreamHandler(sys.stdout)
  handler.setFormatter(formatter)

  root_logger = logging.getLogger()

  # Remove existing handlers to avoid duplicate logs
  for h in root_logger.handlers[:]:
    root_logger.removeHandler(h)

  root_logger.addHandler(handler)
  root_logger.setLevel(log_level)


def setup_tracing(service_name: str) -> None:
  """
  Initializes OpenTelemetry tracing with OTLP exporter for Grafana Cloud.
  """
  endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
  headers = os.getenv("OTEL_EXPORTER_OTLP_HEADERS")

  if not endpoint or not headers:
    log = structlog.get_logger(__name__)
    log.warning(
      "OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_HEADERS not set"
    )
    return

  resource = Resource.create(
    {
      "service.name": service_name,
      "deployment.environment": os.getenv("ENV", "development"),
    }
  )

  provider = TracerProvider(resource=resource)
  otlp_exporter = OTLPSpanExporter(endpoint=endpoint, headers=headers)

  processor = BatchSpanProcessor(otlp_exporter)
  provider.add_span_processor(processor)
  trace.set_tracer_provider(provider)

  log = structlog.get_logger(__name__)
  log.info("OpenTelemetry tracing initialized", service_name=service_name)

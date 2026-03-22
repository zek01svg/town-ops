"""Configuration management for reschedule-job service."""

from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = ConfigDict(
        env_file=".env",
        case_sensitive=False,
        populate_by_name=True,
    )

    # Service configuration
    port: int = Field(default=6006, description="Port to run the service on", alias="RESCHEDULE_JOB_PORT")
    debug: bool = Field(default=False, description="Enable debug mode")

    # Atomic service URLs (from infrastructure standards)
    resident_url: str = Field(
        default="http://resident:5002",
        description="Base URL for resident-atom service",
        alias="RESIDENT_URL"
    )
    appointment_url: str = Field(
        default="http://appointment:5004",
        description="Base URL for appointment-atom service",
        alias="APPOINTMENT_URL"
    )
    case_url: str = Field(
        default="http://case:5001",
        description="Base URL for case-atom service",
        alias="CASE_URL"
    )

    # Messaging
    rabbitmq_url: str = Field(
        default="amqp://guest:guest@localhost:5672",
        description="RabbitMQ connection URL",
        alias="RABBITMQ_URL"
    )

    # OpenTelemetry
    otel_exporter_otlp_endpoint: str | None = Field(
        default=None,
        description="OpenTelemetry OTLP endpoint",
        alias="OTEL_EXPORTER_OTLP_ENDPOINT"
    )

    # Timeouts (in seconds)
    http_timeout: float = Field(
        default=10.0,
        description="HTTP request timeout",
        alias="HTTP_TIMEOUT"
    )
    http_connect_timeout: float = Field(
        default=5.0,
        description="HTTP connection timeout",
        alias="HTTP_CONNECT_TIMEOUT"
    )


def get_settings() -> Settings:
    """Get application settings."""
    return Settings()

import os


class Settings:
  """Runtime configuration loaded from environment variables."""

  port: int = int(os.getenv("PORT", "6004"))
  rabbitmq_url: str = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672")
  case_service_url: str = os.getenv("CASE_SERVICE_URL", "http://case-service:8000")
  proof_service_url: str = os.getenv("PROOF_SERVICE_URL", "http://proof-service:8000")

  # Exchange / routing key for the Job_Done event
  job_done_exchange: str = os.getenv("JOB_DONE_EXCHANGE", "townops.events")
  job_done_routing_key: str = os.getenv("JOB_DONE_ROUTING_KEY", "job.done")

  # Allowed final-status values this service accepts
  allowed_final_statuses: frozenset[str] = frozenset({"CLOSED"})

  # HTTP client timeout (seconds)
  http_timeout: float = float(os.getenv("HTTP_TIMEOUT", "10"))


settings = Settings()

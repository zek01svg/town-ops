from dotenv import load_dotenv
from pydantic_settings import BaseSettings

load_dotenv()


class Settings(BaseSettings):
  PORT: int = 6005
  RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672"
  DATABASE_URL: str = "postgresql://localhost"
  ASSIGNMENT_ATOM_URL: str = "http://localhost:8001"
  CASE_ATOM_URL: str = "http://localhost:8002"
  METRICS_ATOM_URL: str = "http://localhost:8003"
  OUTSYSTEMS_URL: str = "http://localhost:8004"

  class Config:
    env_file = ".env"
    extra = "ignore"


settings = Settings()

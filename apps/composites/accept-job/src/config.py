from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
  model_config = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
  )

  PORT: int = 6003
  APPOINTMENT_SERVICE_URL: str = "http://localhost:5004"
  ASSIGNMENT_SERVICE_URL: str = "http://localhost:5003"
  CASE_SERVICE_URL: str = "http://localhost:5001"
  JWKS_URI: str = ""
  LOG_LEVEL: str = "INFO"
  ENV: str = "development"


@lru_cache
def get_settings() -> Settings:
  return Settings()

"""conftest.py — shared fixtures and test settings for accept-job tests."""

import pytest


# Use asyncio backend for anyio-based async tests
@pytest.fixture(scope="session")
def anyio_backend():
  return "asyncio"

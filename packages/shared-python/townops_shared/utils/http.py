import os
from typing import Any

import httpx


class HttpClient:
  """Shared HTTP Client wrapper using httpx for Python composites."""

  def __init__(self) -> None:
    """Initialize AsyncClient with absolute variables from environment."""
    http_timeout = float(os.environ.get("HTTP_TIMEOUT", "10.0"))
    http_connect_timeout = float(os.environ.get("HTTP_CONNECT_TIMEOUT", "5.0"))

    self.client = httpx.AsyncClient(
      timeout=httpx.Timeout(
        http_timeout,
        connect=http_connect_timeout,
      )
    )

  async def get(self, url: str, **kwargs: Any) -> httpx.Response:
    """Send HTTP GET request."""
    return await self.client.get(url, **kwargs)

  async def post(self, url: str, json: Any = None, **kwargs: Any) -> httpx.Response:
    """Send HTTP POST request with JSON payload."""
    return await self.client.post(url, json=json, **kwargs)

  async def put(self, url: str, json: Any = None, **kwargs: Any) -> httpx.Response:
    """Send HTTP PUT request with JSON payload."""
    return await self.client.put(url, json=json, **kwargs)

  async def patch(self, url: str, json: Any = None, **kwargs: Any) -> httpx.Response:
    """Send HTTP PATCH request with JSON payload."""
    return await self.client.patch(url, json=json, **kwargs)

  async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
    """Send HTTP DELETE request."""
    return await self.client.delete(url, **kwargs)

  async def close(self) -> None:
    """Close the underlying HTTP client connection absolute."""
    await self.client.aclose()

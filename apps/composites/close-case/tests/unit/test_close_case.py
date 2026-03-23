from typing import Any

import httpx
from fastapi import status
from fastapi.testclient import TestClient


def test_health_check(client: TestClient) -> None:
    """Verify the /health endpoint is operational."""
    response = client.get("/health")
    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {"status": "ok", "service": "close-case"}


def test_validation_missing_proof(
    client: TestClient,
    valid_close_payload: dict[str, Any],
) -> None:
    """Ensure we reject requests that have an empty proof_items list."""
    payload = valid_close_payload.copy()
    payload["proof_items"] = []

    response = client.post("/close-case", json=payload)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_validation_invalid_status(
    client: TestClient,
    valid_close_payload: dict[str, Any],
) -> None:
    """Ensure we reject requests that don't have 'CLOSED' as the final_status."""
    payload = valid_close_payload.copy()
    payload["final_status"] = "OPEN"

    response = client.post("/close-case", json=payload)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_close_case_not_found(
    client: TestClient,
    valid_close_payload: dict[str, Any],
    mock_case_service: dict[str, Any],
) -> None:
    """Ensure we correctly handle Case Service returning a 404."""
    mock_case_service["get"].side_effect = httpx.HTTPStatusError(
        "Not Found",
        request=httpx.Request("GET", "mock://case-service/cases/101"),
        response=httpx.Response(status.HTTP_404_NOT_FOUND),
    )

    response = client.post("/close-case", json=valid_close_payload)

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "not found" in response.json()["detail"].lower()


def test_proof_service_failure(
    client: TestClient,
    valid_close_payload: dict[str, Any],
    mock_case_service: dict[str, Any],
    mock_proof_service: Any,
) -> None:
    """Ensure we return a 502 if the Proof Service fails to store items."""
    mock_case_service["get"].return_value = {"id": 101}

    mock_proof_service.side_effect = httpx.HTTPStatusError(
        "Internal Server Error",
        request=httpx.Request("POST", "mock://proof-service/proof"),
        response=httpx.Response(status.HTTP_500_INTERNAL_SERVER_ERROR),
    )

    response = client.post("/close-case", json=valid_close_payload)

    assert response.status_code == status.HTTP_502_BAD_GATEWAY
    assert "proof service failed" in response.json()["detail"].lower()

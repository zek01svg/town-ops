from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
import respx
from httpx import Response

from src.clients import (
    create_appointment,
    update_assignment_status,
    update_case_status,
)


@pytest.mark.anyio
@respx.mock
async def test_update_assignment_status_success() -> None:
    async with httpx.AsyncClient() as client:
        assignment_id = uuid4()
        base_url = "http://localhost:5003"

        route = respx.put(f"{base_url}/api/assignments/{assignment_id}/status").mock(
            return_value=Response(200, json={"assignment": {"status": "accepted"}})
        )

        result = await update_assignment_status(
            client, base_url, assignment_id, "accepted"
        )

        assert route.called
        assert result["status"] == "accepted"


@pytest.mark.anyio
@respx.mock
async def test_update_assignment_status_failure() -> None:
    async with httpx.AsyncClient() as client:
        assignment_id = uuid4()
        base_url = "http://localhost:5003"

        respx.put(f"{base_url}/api/assignments/{assignment_id}/status").mock(
            return_value=Response(500, text="Internal Error")
        )

        with pytest.raises(RuntimeError) as exc:
            await update_assignment_status(
                client, base_url, assignment_id, "accepted"
            )
        assert "Assignment status update" in str(exc.value)


@pytest.mark.anyio
@respx.mock
async def test_update_case_status_success() -> None:
    async with httpx.AsyncClient() as client:
        case_id = uuid4()
        base_url = "http://localhost:5001"

        route = respx.put(f"{base_url}/api/cases/update-case-status/").mock(
            return_value=Response(200, json={"cases": {"status": "in_progress"}})
        )

        result = await update_case_status(
            client, base_url, case_id, "in_progress"
        )

        assert route.called
        assert result["status"] == "in_progress"


@pytest.mark.anyio
@respx.mock
async def test_create_appointment_success() -> None:
    async with httpx.AsyncClient() as client:
        case_id = uuid4()
        assignment_id = uuid4()
        base_url = "http://localhost:5004"
        start_time = datetime.now(timezone.utc)
        end_time = datetime.now(timezone.utc)

        route = respx.post(f"{base_url}/api/appointments").mock(
            return_value=Response(201, json={"appointment": {"status": "scheduled"}})
        )

        result = await create_appointment(
            client, base_url, case_id, assignment_id, start_time, end_time
        )

        assert route.called
        assert result["status"] == "scheduled"


@pytest.mark.anyio
@respx.mock
async def test_update_assignment_status_with_auth() -> None:
    async with httpx.AsyncClient() as client:
        assignment_id = uuid4()
        base_url = "http://localhost:5003"

        route = respx.put(f"{base_url}/api/assignments/{assignment_id}/status").mock(
            return_value=Response(200, json={"assignment": {"status": "accepted"}})
        )

        result = await update_assignment_status(
            client, base_url, assignment_id, "accepted", authorization="Bearer token123"
        )

        assert route.called
        assert route.calls.last.request.headers.get("Authorization") == "Bearer token123"
        assert result["status"] == "accepted"


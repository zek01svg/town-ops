import httpx
import pytest
import respx
from fastapi import status
from src.case_client import get_case, update_case_status
from src.config import settings
from src.proof_client import store_proof
from src.schemas import ProofItem
from townops_shared.utils.http import HttpClient


@pytest.mark.anyio
@respx.mock
async def test_get_case_success(respx_mock):
  case_id = 101
  mock_resp = {"id": case_id, "status": "ASSIGNED"}
  respx_mock.get(f"{settings.case_service_url}/cases/{case_id}").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json=mock_resp)
  )

  client = HttpClient()
  try:
    result = await get_case(client, case_id)
    assert result == mock_resp
  finally:
    await client.close()


@pytest.mark.anyio
@respx.mock
async def test_get_case_failure(respx_mock):
  case_id = 101
  respx_mock.get(f"{settings.case_service_url}/cases/{case_id}").mock(
    return_value=httpx.Response(status.HTTP_404_NOT_FOUND)
  )

  client = HttpClient()
  try:
    with pytest.raises(httpx.HTTPStatusError):
      await get_case(client, case_id)
  finally:
    await client.close()


@pytest.mark.anyio
@respx.mock
async def test_update_case_status_success(respx_mock):
  case_id = 101
  respx_mock.put(f"{settings.case_service_url}/cases/{case_id}/status").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"success": True})
  )

  client = HttpClient()
  try:
    result = await update_case_status(client, case_id, "CLOSED")
    assert result == {"success": True}
  finally:
    await client.close()


@pytest.mark.anyio
@respx.mock
async def test_store_proof_success(respx_mock):
  case_id = 101
  proof_items = [ProofItem(media_url="http://cdn/1.jpg", type="image", remarks="Done")]
  respx_mock.post(f"{settings.proof_service_url}/proof").mock(
    return_value=httpx.Response(status.HTTP_200_OK, json={"ids": [505]})
  )

  client = HttpClient()
  try:
    result = await store_proof(client, case_id, 9001, proof_items)
    assert result == {"ids": [505]}
  finally:
    await client.close()

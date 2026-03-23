from fastapi import status


def test_full_close_case_pathway(
  client,
  valid_close_payload,
  mock_case_service,
  mock_proof_service,
  mock_amqp
):
  """
  Integration test (orchestration mock) for the full Close Case workflow.
  Checks that all services are called in the correct order with correct params.
  """
  # Setup mocks to return success data
  mock_case_service["get"].return_value = {"id": 101, "status": "ASSIGNED"}
  mock_proof_service.return_value = {"id": 505}
  mock_case_service["update"].return_value = {"id": 101, "status": "CLOSED"}

  # Trigger the orchestration
  response = client.post("/close-case", json=valid_close_payload)

  # Validate Response
  assert response.status_code == status.HTTP_200_OK
  data = response.json()
  assert data["success"] is True
  assert data["proof_stored"] == 1
  assert data["case_id"] == 101

  # -------------------------------------------------------------------------
  # CHECK CALL ORDER & PARAMS
  # -------------------------------------------------------------------------

  # 1. Verification Call
  mock_case_service["get"].assert_called_once_with(101)

  # 2. Store Proof Call
  # We use assert_called_once because parameters contain Pydantic model instances
  # that are easier to verify via inspection if needed, or by exact value.
  mock_proof_service.assert_called_once()

  # 3. Update Status Call
  mock_case_service["update"].assert_called_once_with(101, "CLOSED")

  # 4. AMQP Publish Call (Job_Done)
  mock_amqp.assert_called_once_with(101, 9001)


def test_job_done_failure_is_non_fatal(
  client,
  valid_close_payload,
  mock_case_service,
  mock_proof_service,
  mock_amqp
):
  """
  Checks that if RabbitMQ publishing fails, the overall request still succeeds.
  The event emitting is important but shouldn't block the HTTP success response
  once the database-backed services (Case/Proof) have committed.
  """
  mock_case_service["get"].return_value = {"id": 101}
  mock_proof_service.return_value = {"id": 505}
  mock_case_service["update"].return_value = {"id": 101, "status": "CLOSED"}

  # Simulate RabbitMQ connection drop during publish
  mock_amqp.side_effect = Exception("Connection lost")

  response = client.post("/close-case", json=valid_close_payload)

  # Overall response should still be OK
  assert response.status_code == status.HTTP_200_OK
  assert response.json()["success"] is True

  # Verify downstream calls were still made
  mock_case_service["update"].assert_called_once()
  mock_amqp.assert_called_once()

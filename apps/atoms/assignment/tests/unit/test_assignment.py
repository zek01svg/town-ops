from datetime import UTC, datetime, timedelta


def test_response_due_at_is_two_hours_after_assigned_at():
  assigned_at = datetime.now(UTC)
  response_due_at = assigned_at + timedelta(hours=2)
  assert response_due_at - assigned_at == timedelta(hours=2)


def test_assignment_status_values():
  from src.models import AssignmentStatus

  assert AssignmentStatus.PENDING_ACCEPTANCE == "PENDING_ACCEPTANCE"
  assert AssignmentStatus.ACCEPTED == "ACCEPTED"
  assert AssignmentStatus.BREACHED == "BREACHED"


def test_assignment_source_values():
  from src.models import AssignmentSource

  assert AssignmentSource.AUTO_ASSIGN == "AUTO_ASSIGN"
  assert AssignmentSource.MANUAL_ASSIGN == "MANUAL_ASSIGN"
  assert AssignmentSource.BREACH_REASSIGN == "BREACH_REASSIGN"

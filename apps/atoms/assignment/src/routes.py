from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from utils.database import get_session

from apps.atoms.assignment.src.publisher import publish_job_assigned

from .models import Assignment, AssignmentStatus, AssignmentStatusHistory
from .schemas import AssignmentCreate, AssignmentResponse, AssignmentStatusUpdate

router = APIRouter()


@router.get("/health")
def get_health():
  return {"status": "ok"}


@router.post("/assignments", response_model=AssignmentResponse)
async def create_assignment(
  body: AssignmentCreate,
  session: Session = Depends(get_session),  # noqa: B008
):
  assignment = Assignment(
    case_id=body.case_id,
    contractor_id=body.contractor_id,
    source=body.source,
    notes=body.notes,
    status=AssignmentStatus.PENDING_ACCEPTANCE,
  )
  assignment.response_due_at = assignment.assigned_at + timedelta(hours=2)
  session.add(assignment)
  session.commit()
  session.refresh(assignment)
  assert assignment.id is not None
  await publish_job_assigned(
    assignment_id=assignment.id,
    case_id=assignment.case_id,
    contractor_id=assignment.contractor_id,
  )
  return assignment


@router.get("/assignments/{id}", response_model=AssignmentResponse)
def get_assignment(
  id: int,
  session: Session = Depends(get_session),  # noqa: B008
):
  assignment = session.get(Assignment, id)
  if not assignment:
    raise HTTPException(status_code=404, detail="Assignment not found")
  return assignment


@router.get("/assignments/case/{case_id}", response_model=AssignmentResponse)
def get_assignment_by_case(
  case_id: int,
  session: Session = Depends(get_session),  # noqa: B008
):
  statement = select(Assignment).where(Assignment.case_id == case_id)
  assignment = session.exec(statement).first()
  if not assignment:
    raise HTTPException(status_code=404, detail="Assignment not found")
  return assignment


@router.get(
  "/assignments/contractor/{contractor_id}", response_model=list[AssignmentResponse]
)
def get_assignments_by_contractor(
  contractor_id: int,
  session: Session = Depends(get_session),  # noqa: B008
):
  statement = select(Assignment).where(Assignment.contractor_id == contractor_id)
  assignments = session.exec(statement).all()
  return assignments


@router.put("/assignments/{id}/status", response_model=AssignmentResponse)
def update_assignment_status(
  id: int,
  body: AssignmentStatusUpdate,
  session: Session = Depends(get_session),  # noqa: B008
):
  assignment = session.get(Assignment, id)
  if not assignment:
    raise HTTPException(status_code=404, detail="Assignment not found")

  history = AssignmentStatusHistory(
    assignment_id=id,
    from_status=assignment.status,
    to_status=body.status,
    changed_by=body.changed_by,
    reason=body.reason,
  )

  assignment.status = body.status
  assignment.updated_at = datetime.now(UTC)

  if body.status == AssignmentStatus.ACCEPTED:
    assignment.accepted_at = datetime.now(UTC)

  session.add(history)
  session.add(assignment)
  session.commit()
  session.refresh(assignment)
  return assignment

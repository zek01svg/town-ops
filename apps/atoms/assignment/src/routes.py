from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from scalar_fastapi import get_scalar_api_reference
from sqlmodel import Session, select

from .database import get_session
from .models import Assignment, AssignmentStatus, AssignmentStatusHistory
from .schemas import AssignmentCreate, AssignmentResponse, AssignmentStatusUpdate

router = APIRouter()


@router.get("/health", include_in_schema=False)
def get_health() -> dict[str, str]:
  return {"status": "ok"}


@router.get("/scalar", include_in_schema=False)
def scalar_docs() -> dict[str, str]:
  return get_scalar_api_reference(
    openapi_url="/openapi.json",
    title="Assignment Service",
  )


@router.post("/assignments/new-assignment", response_model=AssignmentResponse)
async def create_assignment(
  body: AssignmentCreate,
  session: Session = Depends(get_session),  # noqa: B008
) -> AssignmentResponse:
  now = datetime.now(UTC)
  assignment = Assignment(
    case_id=body.case_id,
    contractor_id=body.contractor_id,
    source=body.source,
    notes=body.notes,
    status=AssignmentStatus.PENDING_ACCEPTANCE,
    assigned_at=now,
    response_due_at=now + timedelta(hours=2),
  )
  session.add(assignment)
  session.commit()
  session.refresh(assignment)
  return assignment


@router.get("/assignments/get-by-id/{id}", response_model=AssignmentResponse)
def get_assignment(
  id: str,  # noqa: A002
  session: Session = Depends(get_session),  # noqa: B008
) -> AssignmentResponse:
  assignment = session.get(Assignment, id)
  if not assignment:
    raise HTTPException(status_code=404, detail="Assignment not found")
  return assignment


@router.get("/assignments/get-by-case/{case_id}", response_model=AssignmentResponse)
def get_assignment_by_case(
  case_id: str,
  session: Session = Depends(get_session),  # noqa: B008
) -> AssignmentResponse:
  statement = select(Assignment).where(Assignment.case_id == case_id)
  assignment = session.exec(statement).first()
  if not assignment:
    raise HTTPException(status_code=404, detail="Assignment not found")
  return assignment


@router.get(
  "/assignments/get-by-contractor/{contractor_id}",
  response_model=list[AssignmentResponse],
)
def get_assignments_by_contractor(
  contractor_id: str,
  session: Session = Depends(get_session),  # noqa: B008
) -> list[AssignmentResponse]:
  statement = select(Assignment).where(Assignment.contractor_id == contractor_id)
  return session.exec(statement).all()


@router.put("/assignments/update-status/{id}", response_model=AssignmentResponse)
def update_assignment_status(
  id: str,  # noqa: A002
  body: AssignmentStatusUpdate,
  session: Session = Depends(get_session),  # noqa: B008
) -> AssignmentResponse:
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

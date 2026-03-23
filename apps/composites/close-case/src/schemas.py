from pydantic import BaseModel, HttpUrl, field_validator


class ProofItem(BaseModel):
  """A single piece of evidence submitted by the contractor."""

  media_url: HttpUrl
  type: str  # e.g. "image", "video"
  remarks: str | None = None


class CloseCaseRequest(BaseModel):
  """Request body for POST /close-case."""

  case_id: int
  uploader_id: int
  proof_items: list[ProofItem]
  final_status: str = "CLOSED"

  @field_validator("final_status")
  @classmethod
  def status_must_be_closed(cls, v: str) -> str:
    if v.upper() != "CLOSED":
      msg = "final_status must be 'CLOSED'"
      raise ValueError(msg)
    return v.upper()

  @field_validator("proof_items")
  @classmethod
  def at_least_one_proof(cls, v: list[ProofItem]) -> list[ProofItem]:
    if not v:
      msg = "proof_items must contain at least one item"
      raise ValueError(msg)
    return v


class CloseCaseResponse(BaseModel):
  """Structured response returned after successfully closing a case."""

  success: bool
  case_id: int
  message: str
  proof_stored: int  # number of proof items saved

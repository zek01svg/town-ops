import logging

import uvicorn
from fastapi import FastAPI

app = FastAPI(title="Mock Atom APIs")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.get("/contractors/backup")
async def get_backup_query(case_id: str) -> dict[str, str]:
  logger.info("Mocked Contractor query for case: %s", case_id)
  return {"worker_id": "backup_contractor_jenny_99"}


@app.put("/assignments/{assignment_id}")
async def put_assignment_worker(assignment_id: str, payload: dict) -> dict[str, str]:
  logger.info("Mocked Assignment update for %s Payload: %s", assignment_id, payload)
  return {"status": "success", "id": assignment_id}


@app.put("/cases/{case_id}/status")
async def put_case_escalated(case_id: str, payload: dict) -> dict[str, str]:
  logger.info("Mocked Case update for %s Payload: %s", case_id, payload)
  return {"status": "success", "id": case_id}


@app.post("/metrics/penalty")
async def post_metrics_penalty(payload: dict) -> dict[str, str]:
  logger.info("Mocked Metrics penalty Payload: %s", payload)
  return {"status": "success"}


if __name__ == "__main__":
  uvicorn.run(app, host="127.0.0.1", port=8088)

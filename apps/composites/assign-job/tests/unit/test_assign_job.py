from src.services import select_best


def test_select_best_picks_lowest_jobs():
  contractors = [
    {"contractor_id": "uuid-1", "total_jobs": 10, "total_score": 50},
    {"contractor_id": "uuid-2", "total_jobs": 3, "total_score": 40},
    {"contractor_id": "uuid-3", "total_jobs": 7, "total_score": 60},
  ]
  result = select_best(contractors)
  assert result["contractor_id"] == "uuid-2"


def test_select_best_uses_score_as_tiebreaker():
  contractors = [
    {"contractor_id": "uuid-1", "total_jobs": 5, "total_score": 30},
    {"contractor_id": "uuid-2", "total_jobs": 5, "total_score": 80},
  ]
  result = select_best(contractors)
  assert result["contractor_id"] == "uuid-2"


def test_sector_code_extraction():
  postal_code = "560123"
  sector_code = postal_code[:2]
  assert sector_code == "56"

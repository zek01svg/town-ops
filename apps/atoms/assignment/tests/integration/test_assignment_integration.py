import os
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel
from testcontainers.postgres import PostgresContainer


@pytest.fixture(scope="session")
def postgres():
  with PostgresContainer("postgres:16-alpine") as pg:
    url = pg.get_connection_url()
    os.environ["DATABASE_URL"] = url
    yield pg


@pytest.fixture(scope="session")
def db_engine(postgres):  # noqa: ARG001
  from src.database import engine

  SQLModel.metadata.create_all(engine)
  yield engine
  SQLModel.metadata.drop_all(engine)


@pytest.fixture
def db_session(db_engine):
  with Session(db_engine) as session:
    yield session
    session.rollback()


@pytest.fixture
def client(db_session):
  from src.database import get_session
  from src.main import app

  def override_get_session() -> Generator:
    yield db_session

  app.dependency_overrides[get_session] = override_get_session
  with TestClient(app) as c:
    yield c
  app.dependency_overrides.clear()


def test_create_assignment(client):
  response = client.post(
    "/assignments/new-assignment",
    json={
      "case_id": "550e8400-e29b-41d4-a716-446655440001",
      "contractor_id": "550e8400-e29b-41d4-a716-446655440002",
      "source": "AUTO_ASSIGN",
    },
  )
  assert response.status_code == 200
  data = response.json()
  assert data["status"] == "PENDING_ACCEPTANCE"
  assert data["case_id"] == "550e8400-e29b-41d4-a716-446655440001"
  assert "response_due_at" in data


def test_get_assignment_by_id(client):
  create = client.post(
    "/assignments/new-assignment",
    json={
      "case_id": "550e8400-e29b-41d4-a716-446655440003",
      "contractor_id": "550e8400-e29b-41d4-a716-446655440004",
      "source": "AUTO_ASSIGN",
    },
  )
  assignment_id = create.json()["id"]
  response = client.get(f"/assignments/get-by-id/{assignment_id}")
  assert response.status_code == 200
  assert response.json()["id"] == assignment_id


def test_get_assignment_by_case(client):
  case_id = "550e8400-e29b-41d4-a716-446655440005"
  client.post(
    "/assignments/new-assignment",
    json={
      "case_id": case_id,
      "contractor_id": "550e8400-e29b-41d4-a716-446655440006",
      "source": "AUTO_ASSIGN",
    },
  )
  response = client.get(f"/assignments/get-by-case/{case_id}")
  assert response.status_code == 200
  assert response.json()["case_id"] == case_id


def test_update_assignment_status(client):
  create = client.post(
    "/assignments/new-assignment",
    json={
      "case_id": "550e8400-e29b-41d4-a716-446655440007",
      "contractor_id": "550e8400-e29b-41d4-a716-446655440008",
      "source": "AUTO_ASSIGN",
    },
  )
  assignment_id = create.json()["id"]
  response = client.put(
    f"/assignments/update-status/{assignment_id}",
    json={
      "status": "ACCEPTED",
      "changed_by": "AcceptJobComposite",
      "reason": "Contractor acknowledged",
    },
  )
  assert response.status_code == 200
  assert response.json()["status"] == "ACCEPTED"


def test_get_assignment_not_found(client):
  response = client.get("/assignments/get-by-id/nonexistent-id")
  assert response.status_code == 404


def test_get_assignments_by_contractor(client):
  contractor_id = "550e8400-e29b-41d4-a716-446655440010"
  client.post(
    "/assignments/new-assignment",
    json={
      "case_id": "550e8400-e29b-41d4-a716-446655440011",
      "contractor_id": contractor_id,
      "source": "AUTO_ASSIGN",
    },
  )
  response = client.get(f"/assignments/get-by-contractor/{contractor_id}")
  assert response.status_code == 200
  assert len(response.json()) >= 1
  assert response.json()[0]["contractor_id"] == contractor_id


def test_get_assignment_by_case_not_found(client):
  response = client.get("/assignments/get-by-case/nonexistent-case-id")
  assert response.status_code == 404


def test_update_assignment_status_not_found(client):
  response = client.put(
    "/assignments/update-status/nonexistent-id",
    json={
      "status": "ACCEPTED",
      "changed_by": "TestClient",
      "reason": "Testing 404",
    },
  )
  assert response.status_code == 404


def test_health_check(client):
  response = client.get("/health")
  assert response.status_code == 200
  assert response.json() == {"status": "ok"}

import os
from collections.abc import Generator

from sqlmodel import Session, SQLModel, create_engine

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
  raise ValueError("DATABASE_URL environment variable is not set")

engine = create_engine(DATABASE_URL, echo=True)


def init_db():
  """
  Initializes the database by creating all tables defined in the SQLModel metadata.
  """
  SQLModel.metadata.create_all(engine)


def get_session() -> Generator[Session]:
  """
  Returns a generator that yields a database session.
  """
  with Session(engine) as session:
    yield session

import os

from sqlmodel import Session, SQLModel, create_engine

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://dummy:dummy@localhost/dummy")

# For SQLite during tests or local dev, you can use:
# DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///assignment.db")

# Use pool_pre_ping for resilience
engine = create_engine(DATABASE_URL, pool_pre_ping=True)


def init_db() -> None:
  """Initialize database tables."""
  SQLModel.metadata.create_all(engine)


def get_session() -> Session:
  """FastAPI dependency for database session."""
  with Session(engine) as session:
    yield session

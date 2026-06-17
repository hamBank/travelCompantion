from sqlmodel import create_engine, Session, SQLModel
from sqlalchemy import text

DATABASE_URL = "sqlite:///./travel.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def get_session():
    with Session(engine) as session:
        yield session


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)
    _migrate()


def _migrate():
    """Apply additive schema changes to existing databases."""
    new_columns = [
        "ALTER TABLE trip ADD COLUMN start_date DATETIME",
        "ALTER TABLE trip ADD COLUMN end_date DATETIME",
        "ALTER TABLE itineraryitem ADD COLUMN details TEXT",
    ]
    with engine.connect() as conn:
        for sql in new_columns:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception:
                pass  # column already exists

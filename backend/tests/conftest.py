import os

os.environ.setdefault("CQA_AUTO_MIGRATE", "false")
os.environ.setdefault("CQA_ORGANIZER_MODE", "mock")
os.environ.setdefault("CQA_DATABASE_URL", "sqlite://")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database import Base, get_db, make_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import seed_default_checklist  # noqa: E402


@pytest.fixture
def db():
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = Session()
    seed_default_checklist(session)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def ingested(client):
    r = client.post("/api/v1/ingestion/dev")
    assert r.status_code == 200, r.text
    return r.json()


def make_submission(conversation_id="mock-ru-001", version=1, **overrides):
    answers = {"C01": "Yes", "C02": "N/A", "C03": "N/A", "C04": "20", "C05": "Yes", "C06": "10", "C07": "Yes", "C08": "No"}
    answers.update(overrides)
    return {
        "conversation_id": conversation_id,
        "checklist_version": version,
        "source": "test",
        "criteria": [
            {"criterion_id": cid, "answer": a, "explanation": f"explanation for {cid}",
             "evidence_message_ids": ["m3"] if cid == "C01" else []}
            for cid, a in answers.items() if a is not None
        ],
    }

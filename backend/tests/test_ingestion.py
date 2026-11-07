import json
from decimal import Decimal

import httpx
import pytest

from app.config import Settings
from app.errors import UpstreamError
from app.services.ingestion_service import ingest_group, parse_timestamp
from app.services.organizer_client import MOCK_DIR, OrganizerClient


def test_ingest_dev_mock(client, ingested):
    assert ingested["source"] == "mock"
    assert ingested["created"] == ingested["fetched"] == 6
    r = client.get("/api/v1/conversations/mock-call-ru-001").json()
    assert r["channel_type"] == "call"
    assert r["audio_url"].endswith(".mp3")
    m = r["messages"]
    assert [x["message_id"] for x in m] == ["m1", "m2", "m3", "m4"]
    assert m[0]["timestamp_raw"] == "2026-11-06T10:15:02+05:00"  # timezone preserved
    assert m[2]["offset_seconds"] == 29.0
    chat = client.get("/api/v1/conversations/mock-ru-001").json()
    assert chat["messages"][2]["timestamp_raw"] == "00:40" and chat["messages"][2]["offset_seconds"] == 40.0


def test_reingest_is_idempotent(client, ingested):
    again = client.post("/api/v1/ingestion/dev").json()
    assert again["created"] == 0 and again["skipped"] == 6
    status = client.get("/api/v1/ingestion/status").json()
    assert status["conversations_total"] == 6
    assert status["by_channel"] == {"call": 1, "chat": 5}
    assert len(status["last_runs"]) == 2


def test_control_mock(client):
    r = client.post("/api/v1/ingestion/control", json={"group_id": "CONTROL"})
    assert r.status_code == 200 and r.json()["created"] == 2
    lst = client.get("/api/v1/conversations", params={"dataset_group": "CONTROL"}).json()
    assert lst["total"] == 2


def test_upload_payload_and_conflict(client, ingested):
    payload = json.loads((MOCK_DIR / "dev_mock.json").read_text())
    payload["data"]["records"][0]["transcript"][0]["text"] = "changed"
    payload["data"]["records"].append({"conversation_id": "", "transcript": []})
    r = client.post("/api/v1/ingestion/upload", json={"payload": payload}).json()
    assert r["conflicts"] == 1 and r["failed"] == 1 and r["skipped"] == 5
    # original kept
    first = client.get("/api/v1/conversations/mock-ru-001").json()
    assert first["messages"][0]["text"] != "changed"


def _live_settings(**kw):
    return Settings(organizer_api_url="https://organizer.test/api/data", organizer_mode="live",
                    organizer_max_retries=2, **kw)


def _payload(records, total=None):
    return {"error": "", "isSuccess": True,
            "data": {"dataset_group_id": "DEV", "total_records": total if total is not None else len(records),
                     "records": records}}


def _rec(i):
    return {"conversation_id": f"p1-ru-{i:03d}", "channel": "agent chat", "language": "RU",
            "transcript": [{"timestamp": "00:02", "speaker": "operator", "text": "Здравствуйте!"}], "audio_url": None}


def test_live_fetch_with_retry(db):
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503)
        assert request.url.params["group_id"] == "DEV"
        return httpx.Response(200, json=_payload([_rec(i) for i in range(1, 66)]))

    s = _live_settings()
    client = OrganizerClient(s, transport=httpx.MockTransport(handler), sleep=lambda _: None)
    run = ingest_group(db, s, kind="dev", group_id="DEV", client=client)
    assert run.source == "live" and run.created == 65 and run.total_reported == 65
    assert len(calls) == 2


def test_live_pagination(db):
    recs = [_rec(i) for i in range(1, 6)]

    def handler(request):
        p = int(request.url.params["page"])
        return httpx.Response(200, json=_payload(recs[(p - 1) * 2: p * 2], total=5))

    s = _live_settings(organizer_page_param="page", organizer_page_size_param="size", organizer_page_size=2)
    client = OrganizerClient(s, transport=httpx.MockTransport(handler), sleep=lambda _: None)
    assert ingest_group(db, s, kind="dev", group_id="DEV", client=client).created == 5


def test_live_failure_reported(db, client):
    s = _live_settings()
    oc = OrganizerClient(s, transport=httpx.MockTransport(lambda r: httpx.Response(200, json={
        "error": "group not found", "isSuccess": False, "data": None})), sleep=lambda _: None)
    with pytest.raises(UpstreamError):
        ingest_group(db, s, kind="dev", group_id="DEV", client=oc)
    down = OrganizerClient(s, transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("x"))),
                           sleep=lambda _: None)
    with pytest.raises(UpstreamError):
        ingest_group(db, s, kind="dev", group_id="DEV", client=down)
    runs = client.get("/api/v1/ingestion/status").json()["last_runs"]
    assert [r["status"] for r in runs[:2]] == ["failed", "failed"]


def test_live_endpoint_502(client):
    from app.api.routes import get_organizer_client
    from app.main import app
    s = _live_settings()
    app.dependency_overrides[get_organizer_client] = lambda: OrganizerClient(
        s, transport=httpx.MockTransport(lambda r: httpx.Response(500)), sleep=lambda _: None)
    r = client.post("/api/v1/ingestion/dev")
    assert r.status_code == 502 and r.json()["error"]["code"] == "upstream_error"


def test_parse_timestamp():
    assert parse_timestamp("01:05") == ("mmss", Decimal(65), None)
    kind, _, dt = parse_timestamp("2026-11-06T10:15:02+05:00")
    assert kind == "iso8601" and dt.utcoffset().total_seconds() == 5 * 3600
    assert parse_timestamp(None)[0] == "unknown"

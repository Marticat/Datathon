from tests.conftest import make_submission


def submit(client, **kw):
    r = client.post("/api/v1/evaluations/submit", json=make_submission(**kw))
    assert r.status_code == 201, r.text
    return r.json()["evaluation_id"]


def appeal(client, eid, cid="C01", comment="Operator did introduce themselves"):
    return client.post("/api/v1/appeals", json={"evaluation_id": eid, "criterion_id": cid, "comment": comment,
                                                "created_by": "user1"})


def test_appeal_override_recalculates_and_keeps_original(client, ingested):
    eid = submit(client, C01="No")  # C02,C03 N/A -> applicable 65, earned 55 -> 84.62
    assert client.get(f"/api/v1/evaluations/{eid}").json()["final_score"] == 84.62

    r = appeal(client, eid)
    assert r.status_code == 201
    a = r.json()
    assert a["status"] == "open" and a["original_ai_answer"] == "No" and a["evidence"][0]["message_id"] == "m3"
    assert client.get(f"/api/v1/evaluations/{eid}").json()["status"] == "appealed"
    assert appeal(client, eid).status_code == 409  # one open appeal per criterion

    r = client.post(f"/api/v1/appeals/{a['appeal_id']}/review",
                    json={"decision": "change", "answer": "Yes", "reason": "Greeting at m3", "reviewer_id": "rev1"})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["score_before"] == 84.62 and res["score_after"] == 100.0 and res["original_score"] == 84.62
    assert res["appeal"]["status"] == "changed" and res["appeal"]["reviewer_answer"] == "Yes"

    ev = client.get(f"/api/v1/evaluations/{eid}").json()
    assert ev["original_score"] == 84.62 and ev["final_score"] == 100.0 and ev["status"] == "reviewed"
    c01 = ev["criteria"][0]
    assert c01["original_answer"] == "No" and c01["final_answer"] == "Yes" and c01["overridden"]
    assert ev["decisions"][0]["reason"] == "Greeting at m3"
    score = client.get(f"/api/v1/evaluations/{eid}/score").json()
    assert score["original"]["score"] == 84.62 and score["final"]["score"] == 100.0 and score["changed_by_review"]

    # already reviewed
    r = client.post(f"/api/v1/appeals/{a['appeal_id']}/review",
                    json={"decision": "confirm", "reason": "again", "reviewer_id": "rev1"})
    assert r.status_code == 409


def test_appeal_confirm(client, ingested):
    eid = submit(client, C06="7")
    a = appeal(client, eid, "C06").json()
    r = client.post(f"/api/v1/appeals/{a['appeal_id']}/review",
                    json={"decision": "confirm", "reason": "One visible slip", "reviewer_id": "rev"}).json()
    assert r["appeal"]["status"] == "confirmed" and r["score_before"] == r["score_after"]
    lst = client.get("/api/v1/appeals", params={"status": "confirmed"}).json()
    assert lst["total"] == 1


def test_reviewer_reason_mandatory_and_answer_validated(client, ingested):
    eid = submit(client)
    aid = appeal(client, eid, "C04").json()["appeal_id"]
    url = f"/api/v1/appeals/{aid}/review"
    assert client.post(url, json={"decision": "change", "answer": "15", "reviewer_id": "r"}).status_code == 422
    assert client.post(url, json={"decision": "change", "answer": "15", "reason": "   ", "reviewer_id": "r"}).status_code == 422
    assert client.post(url, json={"decision": "change", "reason": "no answer", "reviewer_id": "r"}).status_code == 422
    assert client.post(url, json={"decision": "change", "answer": "13", "reason": "bad", "reviewer_id": "r"}).status_code == 422
    assert client.post(url, json={"decision": "change", "answer": "20", "reason": "same", "reviewer_id": "r"}).status_code == 422
    r = client.post(url, json={"decision": "change", "answer": "N/A", "reason": "No request", "reviewer_id": "r"})
    assert r.status_code == 200 and r.json()["score_after"] == 100.0


def test_gross_error_override(client, ingested):
    eid = submit(client)
    aid = appeal(client, eid, "C08", "Operator asked for personal number").json()["appeal_id"]
    r = client.post(f"/api/v1/appeals/{aid}/review",
                    json={"decision": "change", "answer": "Yes", "reason": "Confirmed", "reviewer_id": "r"}).json()
    assert r["final_gross_error"] is True
    ev = client.get(f"/api/v1/evaluations/{eid}").json()
    assert ev["gross_error"] is False and ev["final_gross_error"] is True


def test_appeal_unknown_criterion(client, ingested):
    eid = submit(client)
    assert appeal(client, eid, "C77").status_code == 422
    assert client.post("/api/v1/appeals", json={"evaluation_id": 999, "criterion_id": "C01", "comment": "x"}).status_code == 404


# ---------------------------------------------------------------- batch
def test_batch_submissions_mode(client, ingested):
    subs = [make_submission("mock-ru-001"), make_submission("mock-en-001", C04="N/A", C07="N/A"),
            make_submission("mock-kz-001", C01="Maybe"), make_submission("missing-conv")]
    r = client.post("/api/v1/evaluations/batch", json={"name": "ctrl", "submissions": subs})
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["status"] == "completed_with_errors"
    assert b["stats"]["succeeded"] == 2 and b["stats"]["failed"] == 2 and b["stats"]["total"] == 4
    failed = {i["conversation_id"]: i["error"]["code"] for i in b["items"] if i["status"] == "failed"}
    assert failed == {"mock-kz-001": "invalid_submission", "missing-conv": "conversation_not_found"}

    # resubmitting the same payloads -> cached, no duplicates
    b2 = client.post("/api/v1/evaluations/batch", json={"submissions": subs[:2]}).json()
    assert b2["stats"]["cached"] == 2 and b2["status"] == "completed"
    assert client.get("/api/v1/evaluations").json()["total"] == 2
    assert client.get(f"/api/v1/evaluations/batch/{b['batch_id']}").json()["stats"]["average_score"] is not None
    assert len(client.get("/api/v1/evaluations/batch").json()) == 2


def test_batch_conversation_mode(client, ingested):
    done = submit(client, conversation_id="mock-ru-001")
    r = client.post("/api/v1/evaluations/batch",
                    json={"conversation_ids": ["mock-ru-001", "mock-ru-002", "mock-ru-002", "ghost"]}).json()
    bid = r["batch_id"]
    items = {i["conversation_id"]: i for i in r["items"]}
    assert len(items) == 3
    assert items["mock-ru-001"]["status"] == "cached" and items["mock-ru-001"]["evaluation_id"] == done
    assert items["mock-ru-002"]["status"] == "pending" and items["ghost"]["status"] == "failed"
    assert r["status"] == "processing" and r["checklist_version"] == 1

    p = make_submission("mock-kz-001")
    p["batch_id"] = bid
    assert client.post("/api/v1/evaluations/submit", json=p).status_code == 422  # not in batch

    p = make_submission("mock-ru-002", C03="Yes")
    p["batch_id"] = bid
    assert client.post("/api/v1/evaluations/submit", json=p).status_code == 201
    b = client.get(f"/api/v1/evaluations/batch/{bid}").json()
    assert b["status"] == "completed_with_errors" and b["stats"]["pending"] == 0 and b["stats"]["progress_pct"] == 100.0


def test_batch_requires_one_mode(client, ingested):
    assert client.post("/api/v1/evaluations/batch", json={}).status_code == 422
    assert client.post("/api/v1/evaluations/batch",
                       json={"conversation_ids": ["a"], "submissions": [make_submission()]}).status_code == 422

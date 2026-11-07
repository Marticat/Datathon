import copy

from tests.conftest import make_submission

SUBMIT = "/api/v1/evaluations/submit"


def errors_of(r):
    return r.json()["error"]["details"]


def test_submit_and_retrieve(client, ingested):
    r = client.post(SUBMIT, json=make_submission(C03="No"))
    assert r.status_code == 201, r.text
    body = r.json()
    # applicable: 10+20(C03 no)+20+15+15+5 = 85 ; earned 65 -> 76.47
    assert body["score"] == 76.47 and body["gross_error"] is False and body["duplicate"] is False
    eid = body["evaluation_id"]

    ev = client.get(f"/api/v1/evaluations/{eid}").json()
    assert ev["checklist_version"] == 1 and ev["original_score"] == ev["final_score"] == 76.47
    c01 = ev["criteria"][0]
    assert c01["criterion_id"] == "C01" and c01["evidence"][0]["message_id"] == "m3"
    assert "Айгерим" in c01["evidence"][0]["text"]

    score = client.get(f"/api/v1/evaluations/{eid}/score").json()
    assert score["original"]["applicable_weight"] == 85 and score["changed_by_review"] is False

    by_conv = client.get("/api/v1/evaluations/conversation/mock-ru-001").json()
    assert [e["evaluation_id"] for e in by_conv] == [eid]
    lst = client.get("/api/v1/evaluations", params={"conversation_id": "mock-ru-001"}).json()
    assert lst["total"] == 1

    conv = client.get("/api/v1/conversations", params={"evaluation_status": "evaluated"}).json()
    assert [c["conversation_id"] for c in conv["items"]] == ["mock-ru-001"]
    assert conv["items"][0]["latest_evaluation"]["final_score"] == 76.47


def test_duplicate_submission_cached_but_history_kept(client, ingested):
    first = client.post(SUBMIT, json=make_submission()).json()
    dup = client.post(SUBMIT, json=make_submission())
    assert dup.status_code == 200 and dup.json()["duplicate"] and dup.json()["evaluation_id"] == first["evaluation_id"]
    second = client.post(SUBMIT, json=make_submission(C06="7"))
    assert second.status_code == 201 and second.json()["evaluation_id"] != first["evaluation_id"]
    assert len(client.get("/api/v1/evaluations/conversation/mock-ru-001").json()) == 2


def test_missing_criterion(client, ingested):
    r = client.post(SUBMIT, json=make_submission(C05=None))
    assert r.status_code == 422
    assert {"criterion_id": "C05", "field": "criterion_id", "error": "missing result for active criterion"} in errors_of(r)


def test_duplicate_criterion(client, ingested):
    p = make_submission()
    p["criteria"].append(copy.deepcopy(p["criteria"][0]))
    r = client.post(SUBMIT, json=p)
    assert r.status_code == 422 and "duplicate criterion_id" in str(errors_of(r))


def test_unknown_criterion(client, ingested):
    r = client.post(SUBMIT, json=make_submission(C42="Yes"))
    assert r.status_code == 422 and errors_of(r)[0]["criterion_id"] == "C42"


def test_invalid_answer_binary_and_scale(client, ingested):
    r = client.post(SUBMIT, json=make_submission(C01="Maybe", C04="13"))
    assert r.status_code == 422
    fields = {(e["criterion_id"], e["field"]) for e in errors_of(r)}
    assert fields == {("C01", "answer"), ("C04", "answer")}


def test_boolean_answer_rejected(client, ingested):
    p = make_submission()
    p["criteria"][0]["answer"] = True
    assert client.post(SUBMIT, json=p).status_code == 422


def test_invalid_evidence_id(client, ingested):
    p = make_submission()
    p["criteria"][0]["evidence_message_ids"] = ["m3", "m999"]
    r = client.post(SUBMIT, json=p)
    assert r.status_code == 422 and "m999" in errors_of(r)[0]["error"]


def test_forbidden_na(client, ingested):
    r = client.post(SUBMIT, json=make_submission(C01="N/A"))
    assert r.status_code == 422 and "not permitted" in errors_of(r)[0]["error"]


def test_gross_error_flag_consistency(client, ingested):
    p = make_submission(C08="Yes")
    p["gross_error"] = False
    assert client.post(SUBMIT, json=p).status_code == 422
    p["gross_error"] = True
    r = client.post(SUBMIT, json=p)
    assert r.status_code == 201 and r.json()["gross_error"] is True and r.json()["score"] == 100.0


def test_unknown_conversation_and_version(client, ingested):
    r = client.post(SUBMIT, json=make_submission(conversation_id="nope"))
    assert r.status_code == 404 and r.json()["error"]["code"] == "conversation_not_found"
    assert client.post(SUBMIT, json=make_submission(version=9)).status_code == 404


def test_validate_dry_run(client, ingested):
    r = client.post("/api/v1/evaluations/validate", json=make_submission())
    assert r.status_code == 200 and r.json()["score"] == 100.0
    assert client.get("/api/v1/evaluations").json()["total"] == 0


def test_all_na_scored_as_null(client, ingested):
    new = client.get("/api/v1/checklist").json()
    crit = [{k: v for k, v in c.items() if k not in ("order", "revision")} for c in new["criteria"]]
    for c in crit:
        if c["criterion_id"] in ("C01", "C05", "C06"):
            c["is_active"] = False
    for c in crit:
        if c["criterion_id"] == "C02":
            c["weight"] = 55  # 55+20+20+5 = 100
    assert client.put("/api/v1/checklist", json={"name": "all-na", "criteria": crit}).status_code == 200
    p = make_submission(version=2, C01=None, C05=None, C06=None, C04="N/A", C07="N/A")
    r = client.post(SUBMIT, json=p)
    assert r.status_code == 201, r.text
    assert r.json()["score"] is None


def test_error_format_consistent(client):
    r = client.get("/api/v1/evaluations/12345")
    assert r.status_code == 404 and set(r.json()["error"]) == {"code", "message", "details"}

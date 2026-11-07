def editable(checklist):
    return [{k: v for k, v in c.items() if k not in ("order", "revision")} for c in checklist["criteria"]]


def test_default_checklist_seeded(client):
    c = client.get("/api/v1/checklist").json()
    assert c["version"] == 1 and c["is_active"]
    assert [x["criterion_id"] for x in c["criteria"]] == [f"C0{i}" for i in range(1, 9)]
    assert sum(x["weight"] for x in c["criteria"] if not x["is_gross_error"]) == 100
    c04 = c["criteria"][3]
    assert c04["scoring_type"] == "scaled" and c04["allowed_values"] == ["0", "5", "10", "15", "20"]
    assert c["criteria"][7]["is_gross_error"] and c["criteria"][7]["weight"] == 0


def test_replace_criterion_creates_new_version(client):
    cur = client.get("/api/v1/checklist").json()
    crit = editable(cur)
    crit[4] = {"criterion_id": "C09", "name": "Проактивность", "section": "Ведение и завершение диалога",
               "weight": 15, "scoring_type": "scaled", "allowed_values": [0, 5, 10], "na_allowed": True,
               "na_rule": "Не было повода", "description": "new criterion"}
    r = client.put("/api/v1/checklist", json={"name": "v2 control", "base_version": 1, "criteria": crit})
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["version"] == 2 and new["criteria"][4]["criterion_id"] == "C09"
    assert new["criteria"][0]["revision"] == 1  # unchanged criterion keeps revision
    versions = client.get("/api/v1/checklist/versions").json()
    assert [(v["version"], v["is_active"]) for v in versions] == [(2, True), (1, False)]
    old = client.get("/api/v1/checklist/versions/1").json()
    assert old["criteria"][4]["criterion_id"] == "C05"  # history preserved

    # stale base_version -> conflict
    r = client.put("/api/v1/checklist", json={"name": "x", "base_version": 1, "criteria": crit})
    assert r.status_code == 409
    # rollback
    assert client.post("/api/v1/checklist/versions/1/activate").json()["is_active"]
    assert client.get("/api/v1/checklist").json()["version"] == 1


def test_changed_criterion_bumps_revision(client):
    crit = editable(client.get("/api/v1/checklist").json())
    crit[0]["description"] = "edited"
    new = client.put("/api/v1/checklist", json={"name": "v2", "criteria": crit}).json()
    assert new["criteria"][0]["revision"] == 2


def test_validation_rules(client):
    base = editable(client.get("/api/v1/checklist").json())

    def put(crit):
        return client.put("/api/v1/checklist", json={"name": "bad", "criteria": crit})

    bad = [dict(c) for c in base]
    bad[0]["weight"] = 11
    r = put(bad)
    assert r.status_code == 422 and "total 100" in str(r.json())

    bad = [dict(c) for c in base] + [dict(base[0])]
    assert "duplicate" in str(put(bad).json())

    bad = [dict(c) for c in base]
    bad[0]["allowed_values"] = ["Yes", "Maybe"]
    assert put(bad).status_code == 422

    bad = [dict(c) for c in base]
    bad[3]["allowed_values"] = ["0", "x"]
    assert put(bad).status_code == 422

    bad = [dict(c) for c in base]
    bad[7]["weight"] = 5
    bad[0]["weight"] = 5
    assert put(bad).status_code == 422  # gross-error criteria must weigh 0

    bad = [dict(c) for c in base]
    bad[0]["weight"] = -1
    assert put(bad).status_code == 422

    assert client.get("/api/v1/checklist").json()["version"] == 1  # nothing saved

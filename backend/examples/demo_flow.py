"""Walk through the 5-minute demo flow against a running backend (no AI involved).

    python examples/demo_flow.py [http://localhost:8000]

Uses examples/submission_example.json as a stand-in for the AI module's output.
"""
import json
import sys
from pathlib import Path

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/") + "/api/v1"
c = httpx.Client(base_url=BASE, timeout=30)


def show(title, r):
    print(f"\n=== {title}  [{r.status_code}]")
    print(json.dumps(r.json(), ensure_ascii=False, indent=1)[:1200])
    return r.json()


show("1. Ingest DEV", c.post("/ingestion/dev"))
show("   Conversations", c.get("/conversations", params={"page_size": 3}))

payload = json.loads((Path(__file__).parent / "submission_example.json").read_text(encoding="utf-8"))
if c.get(f"/conversations/{payload['conversation_id']}").status_code == 404:
    sys.exit(f"{payload['conversation_id']} not ingested (live mode?) — edit submission_example.json")
sub = show("2. AI module submits evaluation", c.post("/evaluations/submit", json=payload))
eid = sub["evaluation_id"]
show("   Score breakdown", c.get(f"/evaluations/{eid}/score"))

ap = show("3. User disputes C07", c.post("/appeals", json={
    "evaluation_id": eid, "criterion_id": "C07", "comment": "Оператор попрощался в m6", "created_by": "demo-user"}))
if "appeal_id" in ap:
    show("   Reviewer changes answer", c.post(f"/appeals/{ap['appeal_id']}/review", json={
        "decision": "change", "answer": "Yes", "reason": "Прощание есть в m6", "reviewer_id": "demo-reviewer"}))

cur = c.get("/checklist").json()
crit = [{k: v for k, v in x.items() if k not in ("order", "revision")} for x in cur["criteria"]]
crit[6] = {**crit[6], "name": crit[6]["name"] + " (изменено)", "description": "Демо: изменённый критерий"}
show("4. Checklist change -> new version", c.put("/checklist", json={
    "name": "Demo v" + str(cur["version"] + 1), "base_version": cur["version"], "criteria": crit}))
show("   Versions", c.get("/checklist/versions"))
show("   Batch work list for AI module", c.post("/evaluations/batch", json={
    "name": "control re-run", "conversation_ids": [x["conversation_id"] for x in c.get("/conversations").json()["items"]]}))

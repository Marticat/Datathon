# CQA Backend: Freedom Broker Conversation Quality Analytics

This is the FastAPI backend for the hackathon prototype. It does:

* organizer API ingestion
* checklist management with versioning
* the integration endpoint for the separate AI module
* the deterministic scoring engine
* evaluation history
* appeals and reviewer decisions
* batch processing
* the REST API the frontend talks to

> **No AI lives here.** The AI teammate's module submits results to `POST /api/v1/evaluations/submit`. See **[docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md)**.

## Quick start

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                    # optional; set CQA_ORGANIZER_API_URL here
uvicorn app.main:app --reload --port 8000
```

* Swagger UI: http://localhost:8000/docs (ReDoc at `/redoc`).
* On startup the app runs the Alembic migrations and seeds **checklist v1**, which is transcribed from the organizers' *Чек-лист качества чатов* PDF (C01–C08). No manual DB steps are needed.
* Tests: `pytest` (53 tests).
* Demo walk-through against a running server: `python examples/demo_flow.py http://localhost:8000`.

### Organizer API

The guide doesn't print the URL; it's behind the "Открыть GET для DEV" button. Copy that link **without** `?group_id=DEV` into `CQA_ORGANIZER_API_URL`. Then:

```bash
curl -X POST localhost:8000/api/v1/ingestion/dev
curl -X POST localhost:8000/api/v1/ingestion/control -H 'content-type: application/json' -d '{"group_id":"<announced id>"}'
curl localhost:8000/api/v1/ingestion/status
```

* Without a URL the backend runs in **mock mode**: 6 DEV and 2 control sample dialogs with ids prefixed `mock-`. They are not organizer data.
* If the API is unreachable, save the response with `curl` and post it as `{"payload": <response json>}` to `POST /api/v1/ingestion/upload`.
* Ingestion is idempotent and conversations are never overwritten. A re-ingest with changed content is reported as a `conflict`.
* Conversation IDs, speaker roles, raw timestamps (MM:SS or ISO 8601 with timezone) and `audio_url` are stored as received. Messages get stable ids `m1…mN`, plus `offset_seconds` for jumping to a point in the audio player.
* Failed attempts are retried with exponential backoff (3 retries on transport errors, 5xx and 429). Pagination can be switched on with `CQA_ORGANIZER_PAGE_PARAM` if the API ever adds it.

### PostgreSQL

```bash
pip install "psycopg[binary]"
export CQA_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/cqa
```

Decimals are stored as exact strings, so the schema is identical on both databases. Migrations are in `alembic/`. Run `alembic upgrade head` manually if `CQA_AUTO_MIGRATE=false`.

## Scoring rules (`app/services/scoring.py`)

`calculate_score(criteria_results, checklist)` is pure Python with `Decimal` and no DB or AI:

| answer | points |
|---|---|
| Yes | full weight |
| No | 0 |
| scaled | step / top step × weight (C04 `15` → 15/20 × 20 = 15) |
| N/A | excluded; the weight is redistributed |

* **Final = 100 × earned / applicable weight**, rounded `ROUND_HALF_UP` to 2 decimals.
* All N/A → `score = null` (the checklist says the total is "не рассчитывается").
* The gross error (C08, weight 0) is a separate flag and never affects the score.
* Section scores are returned too.

Example: C02 and C03 are N/A, C01 is No. Applicable weight is 65, earned is 55, so the score is **84.62**.

## API overview (`/api/v1`)

| area | endpoints |
|---|---|
| Ingestion | `POST /ingestion/dev`, `POST /ingestion/control`, `POST /ingestion/upload`, `GET /ingestion/status` |
| Checklist | `GET /checklist[?version=N]`, `PUT /checklist` (creates and activates a new version), `GET /checklist/versions`, `GET /checklist/versions/{v}`, `POST /checklist/versions/{v}/activate` |
| AI integration | `POST /evaluations/submit`, `POST /evaluations/validate` (dry run) |
| Evaluations | `GET /evaluations?conversation_id&checklist_version&status&batch_id&gross_error&page&page_size`, `GET /evaluations/{id}`, `GET /evaluations/{id}/score`, `GET /evaluations/conversation/{conversation_id}` |
| Appeals | `POST /appeals`, `GET /appeals?status&evaluation_id&conversation_id&criterion_id`, `GET /appeals/{id}`, `POST /appeals/{id}/review` |
| Batch | `POST /evaluations/batch`, `GET /evaluations/batch`, `GET /evaluations/batch/{id}` |
| Conversations | `GET /conversations?q&channel=chat\|call&language&dataset_group&evaluation_status&page&page_size`, `GET /conversations/{id}` |

**Conventions**

* Paginated lists return `{items, total, page, page_size, pages}`.
* Errors return `{"error": {"code", "message", "details"}}`.
* Status codes: 201 on create, 404, 409 (conflict or already reviewed), 422 (validation), 502 (organizer API down).
* CORS is open by default (`CQA_CORS_ORIGINS`).

### What the frontend gets

* **`GET /evaluations/{id}`**: per criterion, `original_answer`, `final_answer`, `overridden`, `explanation`, and `evidence_message_ids` plus the full `evidence` messages (text, timestamp, `offset_seconds`) for highlighting or scrolling the transcript and seeking the audio player. Also `final_effective_weight`, `final_effective_points`, `open_appeal_id`, section scores, and the reviewer `decisions` history.
* **Appeal flow**:
  1. `POST /appeals {evaluation_id, criterion_id, comment}`. The reviewer view in `GET /appeals/{id}` includes the disputed answer, the AI explanation, the comment and the evidence messages.
  2. `POST /appeals/{id}/review {decision: "confirm"|"change", answer?, reason, reviewer_id}`. `reason` is mandatory. The response carries `score_before`, `score_after` and `original_score`.
  3. The original AI result is never modified.
* **Checklist edit**: `PUT /checklist` takes the full list of criteria. Active weights must total 100, and scale, N/A and gross-error rules are validated. Pass `base_version` for optimistic locking. Old versions stay, and every evaluation references the version it was scored with.

## Demo script (5 min) and the backend calls behind it

1. **Interface + dialog**: `GET /conversations`, then `GET /conversations/{id}`.
2. **Evaluation, explanation, jump to message, N/A, total**: `GET /evaluations/conversation/{id}` and `GET /evaluations/{id}/score`.
3. **Appeal, then reviewer decision, then new total**: `POST /appeals`, then `POST /appeals/{id}/review`.
4. **Change a criterion, then apply it**:
   * `PUT /checklist` creates v2.
   * `POST /evaluations/batch {conversation_ids, checklist_version: 2}` produces the work list.
   * The AI module submits with `batch_id`.
   * `GET /evaluations/batch/{id}` shows progress.

## Layout

```
app/
  main.py              app factory, CORS, startup migrations + seed
  config.py            settings (env prefix CQA_)
  models.py            SQLAlchemy models (conversations, messages, checklist versions/criteria,
                       evaluations, criterion results, appeals, reviewer decisions, batch jobs/items,
                       ingestion runs)
  seed.py              organizer checklist v1
  api/routes.py        REST endpoints
  schemas/             Pydantic v2 request/response models
  services/            scoring, checklist, ingestion + organizer client, evaluation, appeals, batch
  mock_data/           MOCK sample datasets (offline mode only)
alembic/               migrations
tests/                 pytest suite (scoring, validation, appeals, ingestion, checklist, batch)
docs/AI_INTEGRATION.md contract for the AI teammate
examples/              sample submission + demo walk-through
```

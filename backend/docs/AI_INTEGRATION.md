# AI module → Backend integration contract

The backend never calls an LLM. The AI module (any language or provider) does three things:

1. **Read** the checklist and the conversations over REST.
2. **Evaluate** them on its own side.
3. **POST** the results to `/api/v1/evaluations/submit`. The backend validates them, stores them, and computes the score deterministically.

Base URL: `http://<host>:8000/api/v1`. Interactive schema: `http://<host>:8000/docs`.

---

## 1. Inputs for the AI module

### Checklist: `GET /checklist`

Returns the active version. Use `GET /checklist?version=N` to get a specific one.

```json
{
  "version": 1,
  "criteria": [
    {"criterion_id": "C01", "name": "Установление контакта", "description": "...", "section": "...",
     "weight": 10, "scoring_type": "binary", "allowed_values": ["Yes","No"],
     "scale_labels": {}, "na_allowed": false, "na_rule": null, "is_gross_error": false, "is_active": true},
    {"criterion_id": "C04", "scoring_type": "scaled", "allowed_values": ["0","5","10","15","20"],
     "scale_labels": {"20": "Все существенные вопросы закрыты...", "...": "..."}, "na_allowed": true,
     "na_rule": "Чат закончился до того, как клиент сформулировал запрос."},
    {"criterion_id": "C08", "is_gross_error": true, "weight": 0, "...": "..."}
  ]
}
```

Build your prompt from `name`, `description`, `scale_labels`, `na_allowed` and `na_rule`. **Always send back the `version` you used** as `checklist_version`.

### Conversations

* `GET /conversations?evaluation_status=not_evaluated&page_size=200` lists the work that is still to do.
* `GET /conversations/{conversation_id}` returns the transcript:

```json
{"conversation_id": "p1-ru-001", "channel": "agent chat", "channel_type": "chat", "language": "RU",
 "audio_url": null,
 "messages": [
   {"message_id": "m1", "position": 0, "speaker": "client", "text": "...", "timestamp_raw": "00:02", "offset_seconds": 2.0},
   {"message_id": "m2", "position": 1, "speaker": "operator", "text": "..."}]}
```

`message_id` is assigned by the backend as `m1, m2, …` in original transcript order (1-based) and is stable. **Evidence must use these ids.**

Speakers are `client`, `operator`, `bot` and `system`. Bot and system lines are context only; the operator is the one being evaluated.

---

## 2. Submit: `POST /evaluations/submit`

### Request

| field | type | required | notes |
|---|---|---|---|
| `conversation_id` | string | yes | must already be ingested |
| `checklist_version` | int | yes | the version you evaluated against |
| `criteria` | array | yes | **exactly one entry per active criterion**, gross-error criterion included |
| `criteria[].criterion_id` | string | yes | e.g. `"C01"`; no duplicates, no unknown ids |
| `criteria[].answer` | string \| number | yes | binary: `"Yes"`, `"No"`, `"N/A"`; scaled: one of `allowed_values` (`"15"` or `15`); `"N/A"` only if `na_allowed` |
| `criteria[].explanation` | string | yes | 1–5000 chars, shown to the user |
| `criteria[].evidence_message_ids` | string[] | no | ids from this conversation. For a missed action, give the place where it was expected; may be `[]` for N/A |
| `gross_error` | bool | no | derived from the gross-error criterion (C08). If you send it, it **must match** the C08 answer |
| `source` | string | no | default `"ai-module"` |
| `model_name` | string | no | e.g. the LLM name, for the jury's cost question |
| `batch_id` | int | no | set it when answering a conversation-mode batch |
| `metadata` | object | no | free-form: latency, token usage, cost, prompt version |

Answers are case-insensitive. Aliases `да/нет/иә/жоқ/na/n/a` are accepted and normalized.

Full example: [`examples/submission_example.json`](../examples/submission_example.json).

### Response

* `201 Created` means a new evaluation was stored.
* `200 OK` with `"duplicate": true` means an identical submission already existed and no new row was created. Retries are safe.

```json
{"evaluation_id": 12, "conversation_id": "p1-ru-001", "checklist_version": 1,
 "score": 84.62, "gross_error": false, "status": "completed", "duplicate": false}
```

`score` is `null` when every weighted criterion is N/A (per the checklist, no score is calculated then).

### Errors

All errors have the same shape: `{"error": {"code", "message", "details"}}`.

| HTTP | code | when |
|---|---|---|
| 404 | `conversation_not_found` | unknown `conversation_id` |
| 404 | `not_found` | unknown `checklist_version` or `batch_id` |
| 422 | `invalid_request` | malformed JSON or schema error (missing field, duplicate `criterion_id`, boolean answer) |
| 422 | `invalid_submission` | business rules failed. `details` lists **every** problem at once |
| 422 | `validation_failed` | conversation isn't in the batch, or wrong version for the batch |

Example `invalid_submission` details:

```json
[{"criterion_id": "C05", "field": "criterion_id", "error": "missing result for active criterion"},
 {"criterion_id": "C01", "field": "answer", "error": "N/A is not permitted for this criterion"},
 {"criterion_id": "C04", "field": "answer", "error": "Invalid scale value '12'; allowed: ['0','5','10','15','20']"},
 {"criterion_id": "C02", "field": "evidence_message_ids", "error": "message ids not found in conversation p1-ru-001: ['m99']"}]
```

### Dry run: `POST /evaluations/validate`

Same body as `/submit`. It validates and scores but **stores nothing**. Use it while tuning prompts.

---

## 3. Batch processing (control set)

**Option A: you have all results already.**
`POST /evaluations/batch` with `{"name": "...", "submissions": [<submit body>, ...]}`. Each item is validated on its own. The response lists `succeeded`, `cached` (identical result already stored) and `failed` (with the error) per conversation.

**Option B: the backend hands out a work list.**

1. Frontend or operator calls `POST /evaluations/batch` with `{"conversation_ids": [...], "checklist_version": 2}`. Conversations already evaluated with that version are marked `cached` (disable with `"reuse_existing": false`).
2. The AI module polls `GET /evaluations/batch/{batch_id}` and processes the items with `"status": "pending"`.
3. For each one it calls `/evaluations/submit` with `"batch_id": <id>` and the batch's `checklist_version`.
4. The batch moves `pending → processing → completed | completed_with_errors`. `stats` shows progress, the average score and the gross-error count.

---

## 4. What the backend does with your result

* Scores in Python with `Decimal`:
  * Yes = full weight, No = 0.
  * Scaled = step / top step × weight.
  * N/A criteria are excluded and their weight is redistributed: `100 × earned / applicable`, rounded half-up to 2 decimals.
* The gross error is a separate flag and never changes the score.
* Your answers are stored **immutably**. Reviewer appeals create separate decision records, and `final_score` is recalculated while `original_score` stays as you submitted it.

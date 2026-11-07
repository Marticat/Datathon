from datetime import datetime

from pydantic import BaseModel

from app.schemas.common import OptDecimalNum


class MessageOut(BaseModel):
    message_id: str
    position: int
    speaker: str
    text: str
    timestamp_raw: str | None
    timestamp_kind: str | None
    offset_seconds: OptDecimalNum


class LatestEvaluation(BaseModel):
    evaluation_id: int
    checklist_version: int
    status: str
    original_score: OptDecimalNum
    final_score: OptDecimalNum
    final_gross_error: bool
    created_at: datetime


class ConversationSummary(BaseModel):
    conversation_id: str
    dataset_group: str
    channel: str
    channel_type: str
    language: str | None
    audio_url: str | None
    message_count: int
    ingested_at: datetime
    evaluation_count: int
    latest_evaluation: LatestEvaluation | None
    preview: str | None


class ConversationDetail(ConversationSummary):
    messages: list[MessageOut]
    evaluations: list[LatestEvaluation]


class IngestionRunOut(BaseModel):
    run_id: int
    dataset_kind: str
    group_id: str
    source: str
    status: str
    total_reported: int | None
    fetched: int
    created: int
    skipped: int
    conflicts: int
    failed: int
    errors: list
    started_at: datetime
    finished_at: datetime | None


class IngestionStatus(BaseModel):
    mode: str
    organizer_api_configured: bool
    dev_group_id: str
    control_group_id: str | None
    conversations_total: int
    by_group: dict[str, int]
    by_channel: dict[str, int]
    by_language: dict[str, int]
    last_runs: list[IngestionRunOut]


class ControlIngestRequest(BaseModel):
    group_id: str | None = None


class UploadIngestRequest(BaseModel):
    """Raw organizer payload pasted/uploaded manually (same JSON as the GET response)."""

    group_id: str | None = None
    payload: dict

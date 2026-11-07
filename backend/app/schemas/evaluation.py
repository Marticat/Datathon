from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import DecimalNum, OptDecimalNum


# ---------------------------------------------------------------- submission (AI -> backend)
class CriterionResultIn(BaseModel):
    criterion_id: str = Field(min_length=1, max_length=64, examples=["C01"])
    answer: str | int | float = Field(
        description='Binary: "Yes" | "No" | "N/A". Scaled: one of the allowed values, e.g. "15" or 15.',
        examples=["Yes"],
    )
    explanation: str = Field(min_length=1, max_length=5000, examples=["Operator greeted and introduced themselves."])
    evidence_message_ids: list[str] = Field(
        default_factory=list, max_length=50, description='Message ids of this conversation, e.g. ["m3"]'
    )

    @field_validator("answer")
    @classmethod
    def _no_bool(cls, v):
        if isinstance(v, bool):
            raise ValueError("answer must be a string or number, not a boolean")
        return v


class EvaluationSubmit(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128, examples=["p1-ru-001"])
    checklist_version: int = Field(ge=1, examples=[1])
    criteria: list[CriterionResultIn] = Field(min_length=1)
    gross_error: bool | None = Field(
        default=None,
        description="Optional. Derived from the gross-error criterion (C08). If sent, it must match it.",
    )
    source: str = Field(default="ai-module", max_length=100)
    model_name: str | None = Field(default=None, max_length=200, examples=["your-llm-name"])
    batch_id: int | None = Field(default=None, description="Set when answering a conversation-mode batch")
    metadata: dict = Field(default_factory=dict, description="Free-form: latency, cost, prompt version...")

    @field_validator("criteria")
    @classmethod
    def _unique(cls, v):
        ids = [c.criterion_id for c in v]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate criterion_id: {dupes}")
        return v


class SubmitResponse(BaseModel):
    evaluation_id: int
    conversation_id: str
    checklist_version: int
    score: OptDecimalNum = Field(description="Final score 0..100, null if no weighted criterion is applicable")
    gross_error: bool
    status: str
    duplicate: bool = Field(description="True if an identical submission already existed (no new row created)")


# ---------------------------------------------------------------- read models
class EvidenceMessage(BaseModel):
    message_id: str
    position: int
    speaker: str
    text: str
    timestamp_raw: str | None
    offset_seconds: OptDecimalNum


class CriterionResultOut(BaseModel):
    criterion_id: str
    name: str
    section: str | None
    weight: DecimalNum
    scoring_type: str
    is_gross_error: bool
    original_answer: str
    final_answer: str
    overridden: bool
    explanation: str
    evidence_message_ids: list[str]
    evidence: list[EvidenceMessage]
    original_points: OptDecimalNum
    final_points: OptDecimalNum
    final_effective_weight: OptDecimalNum
    final_effective_points: OptDecimalNum
    open_appeal_id: int | None


class EvaluationSummary(BaseModel):
    evaluation_id: int
    conversation_id: str
    checklist_version: int
    status: str
    source: str
    model_name: str | None
    original_score: OptDecimalNum
    final_score: OptDecimalNum
    gross_error: bool
    final_gross_error: bool
    batch_id: int | None
    created_at: datetime
    updated_at: datetime


class EvaluationOut(EvaluationSummary):
    criteria: list[CriterionResultOut]
    sections: dict[str, dict]
    decisions: list[dict]


class CriterionScoreOut(BaseModel):
    criterion_id: str
    answer: str
    weight: DecimalNum
    is_na: bool
    counts_toward_score: bool
    fraction: OptDecimalNum
    points: OptDecimalNum
    effective_weight: OptDecimalNum
    effective_points: OptDecimalNum
    section: str | None


class ScoreBreakdown(BaseModel):
    score: OptDecimalNum
    earned_points: DecimalNum
    applicable_weight: DecimalNum
    total_weight: DecimalNum
    gross_error: bool
    criteria: list[CriterionScoreOut]
    sections: dict[str, dict]


class ScoreOut(BaseModel):
    evaluation_id: int
    checklist_version: int
    original: ScoreBreakdown
    final: ScoreBreakdown
    changed_by_review: bool


# ---------------------------------------------------------------- batch
class BatchCreate(BaseModel):
    name: str | None = None
    checklist_version: int | None = Field(
        default=None, description="conversation mode: version the AI must use (default: active)"
    )
    submissions: list[EvaluationSubmit] | None = Field(
        default=None, description="Mode A: evaluation results to store in one go"
    )
    conversation_ids: list[str] | None = Field(
        default=None, description="Mode B: work list for the AI module; results arrive later via /submit with batch_id"
    )
    reuse_existing: bool = Field(
        default=True, description="Mode B: mark conversations already evaluated with this version as cached"
    )

    @field_validator("conversation_ids")
    @classmethod
    def _nonempty(cls, v):
        if v is not None and not v:
            raise ValueError("conversation_ids must not be empty")
        return v


class BatchItemOut(BaseModel):
    conversation_id: str
    status: Literal["pending", "succeeded", "cached", "failed"]
    evaluation_id: int | None
    score: OptDecimalNum = None
    error: dict | None


class BatchOut(BaseModel):
    batch_id: int
    name: str | None
    mode: str
    status: str
    checklist_version: int | None
    created_at: datetime
    finished_at: datetime | None
    stats: dict
    items: list[BatchItemOut]

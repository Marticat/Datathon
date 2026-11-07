from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.common import OptDecimalNum
from app.schemas.evaluation import EvidenceMessage


class AppealCreate(BaseModel):
    evaluation_id: int
    criterion_id: str = Field(min_length=1, max_length=64)
    comment: str = Field(min_length=1, max_length=5000, description="Why the user disputes the result")
    created_by: str | None = Field(default=None, max_length=100)


class AppealReview(BaseModel):
    decision: Literal["confirm", "change"]
    answer: str | int | float | None = Field(
        default=None, description='Required for "change": new answer ("Yes"/"No"/"N/A"/scale value)'
    )
    reason: str = Field(min_length=3, max_length=5000, description="Mandatory reviewer explanation")
    reviewer_id: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def _check(self):
        if not self.reason.strip():
            raise ValueError("reason must not be blank")
        if self.decision == "change" and (self.answer is None or str(self.answer).strip() == ""):
            raise ValueError('answer is required when decision is "change"')
        if isinstance(self.answer, bool):
            raise ValueError("answer must be a string or number")
        return self


class AppealOut(BaseModel):
    appeal_id: int
    evaluation_id: int
    conversation_id: str
    checklist_version: int
    criterion_id: str
    criterion_name: str
    user_comment: str
    created_by: str | None
    original_ai_answer: str
    disputed_answer: str
    ai_explanation: str
    evidence: list[EvidenceMessage]
    status: Literal["open", "confirmed", "changed"]
    reviewer_answer: str | None
    reviewer_reason: str | None
    reviewer_id: str | None
    created_at: datetime
    reviewed_at: datetime | None
    evaluation_original_score: OptDecimalNum
    evaluation_final_score: OptDecimalNum
    evaluation_final_gross_error: bool


class AppealReviewResult(BaseModel):
    appeal: AppealOut
    score_before: OptDecimalNum
    score_after: OptDecimalNum
    original_score: OptDecimalNum
    final_gross_error: bool

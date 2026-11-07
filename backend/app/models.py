"""SQLAlchemy 2.0 ORM models.

Decimal values (weights, scores) are stored through `ExactDecimal`, a string-backed
type, so they round-trip exactly on both SQLite and PostgreSQL.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ExactDecimal(TypeDecorator):
    impl = String(32)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return None if value is None else str(Decimal(value))

    def process_result_value(self, value, dialect):
        return None if value is None else Decimal(value)


# ---------------------------------------------------------------- conversations
class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    dataset_group: Mapped[str] = mapped_column(String(64), index=True)
    channel: Mapped[str] = mapped_column(String(64))  # raw value: "agent chat" / "voice call"
    channel_type: Mapped[str] = mapped_column(String(16), index=True)  # normalized: chat / call
    language: Mapped[str | None] = mapped_column(String(8), index=True)
    audio_url: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    raw_record: Mapped[dict] = mapped_column(JSON)  # untouched organizer record
    message_count: Mapped[int] = mapped_column(Integer, default=0)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", order_by="Message.position", cascade="all, delete-orphan"
    )
    evaluations: Mapped[list[Evaluation]] = relationship(back_populates="conversation")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("conversation_pk", "message_id", name="uq_message_id_per_conversation"),
        UniqueConstraint("conversation_pk", "position", name="uq_message_position"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_pk: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    message_id: Mapped[str] = mapped_column(String(32))  # "m1", "m2", ... stable, 1-based
    position: Mapped[int] = mapped_column(Integer)  # 0-based original order
    speaker: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    timestamp_raw: Mapped[str | None] = mapped_column(String(64))  # exactly as received
    timestamp_kind: Mapped[str | None] = mapped_column(String(16))  # mmss / iso8601 / unknown
    offset_seconds: Mapped[Decimal | None] = mapped_column(ExactDecimal)  # from start of dialog

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


# -------------------------------------------------------------------- checklist
class ChecklistVersion(Base):
    __tablename__ = "checklist_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    version: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    comment: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_by: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    criteria: Mapped[list[ChecklistCriterion]] = relationship(
        back_populates="checklist_version",
        order_by="ChecklistCriterion.order",
        cascade="all, delete-orphan",
    )


class ChecklistCriterion(Base):
    __tablename__ = "checklist_criteria"
    __table_args__ = (
        UniqueConstraint("checklist_version_id", "criterion_id", name="uq_criterion_per_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    checklist_version_id: Mapped[int] = mapped_column(
        ForeignKey("checklist_versions.id", ondelete="CASCADE"), index=True
    )
    criterion_id: Mapped[str] = mapped_column(String(64))
    order: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    section: Mapped[str | None] = mapped_column(String(200))
    weight: Mapped[Decimal] = mapped_column(ExactDecimal)
    scoring_type: Mapped[str] = mapped_column(String(16))  # binary / scaled
    allowed_values: Mapped[list] = mapped_column(JSON)  # ["Yes","No"] or ["0","5",...]
    scale_labels: Mapped[dict] = mapped_column(JSON, default=dict)  # value -> description
    na_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    na_rule: Mapped[str | None] = mapped_column(Text)
    is_gross_error: Mapped[bool] = mapped_column(Boolean, default=False)
    gross_error_config: Mapped[dict] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)  # bumps when the criterion changes

    checklist_version: Mapped[ChecklistVersion] = relationship(back_populates="criteria")


# ------------------------------------------------------------------ evaluations
class Evaluation(Base):
    __tablename__ = "evaluations"
    __table_args__ = (Index("ix_eval_conv_version", "conversation_pk", "checklist_version_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_pk: Mapped[int] = mapped_column(ForeignKey("conversations.id"), index=True)
    checklist_version_id: Mapped[int] = mapped_column(ForeignKey("checklist_versions.id"))
    batch_job_id: Mapped[int | None] = mapped_column(ForeignKey("batch_jobs.id"), index=True)
    source: Mapped[str] = mapped_column(String(100), default="ai-module")
    model_name: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="completed", index=True)
    original_score: Mapped[Decimal | None] = mapped_column(ExactDecimal)  # never modified
    final_score: Mapped[Decimal | None] = mapped_column(ExactDecimal)  # after reviewer decisions
    gross_error: Mapped[bool] = mapped_column(Boolean, default=False)  # never modified
    final_gross_error: Mapped[bool] = mapped_column(Boolean, default=False)
    payload_hash: Mapped[str] = mapped_column(String(64), index=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    conversation: Mapped[Conversation] = relationship(back_populates="evaluations")
    checklist_version: Mapped[ChecklistVersion] = relationship()
    criterion_results: Mapped[list[CriterionResult]] = relationship(
        back_populates="evaluation", cascade="all, delete-orphan", order_by="CriterionResult.id"
    )
    appeals: Mapped[list[Appeal]] = relationship(back_populates="evaluation", order_by="Appeal.id")
    decisions: Mapped[list[ReviewerDecision]] = relationship(
        back_populates="evaluation", order_by="ReviewerDecision.id"
    )


class CriterionResult(Base):
    """Original (AI-submitted) answer for one criterion. Immutable after creation."""

    __tablename__ = "criterion_results"
    __table_args__ = (
        UniqueConstraint("evaluation_id", "criterion_id", name="uq_result_per_criterion"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    evaluation_id: Mapped[int] = mapped_column(
        ForeignKey("evaluations.id", ondelete="CASCADE"), index=True
    )
    criterion_id: Mapped[str] = mapped_column(String(64))
    answer: Mapped[str] = mapped_column(String(32))  # normalized: Yes / No / N/A / "15"
    explanation: Mapped[str] = mapped_column(Text, default="")
    evidence_message_ids: Mapped[list] = mapped_column(JSON, default=list)
    points_earned: Mapped[Decimal | None] = mapped_column(ExactDecimal)  # None when N/A / no weight

    evaluation: Mapped[Evaluation] = relationship(back_populates="criterion_results")


# ---------------------------------------------------------------------- appeals
class Appeal(Base):
    __tablename__ = "appeals"
    __table_args__ = (Index("ix_appeal_eval_criterion", "evaluation_id", "criterion_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    evaluation_id: Mapped[int] = mapped_column(ForeignKey("evaluations.id"), index=True)
    criterion_id: Mapped[str] = mapped_column(String(64))
    user_comment: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(100))
    original_answer: Mapped[str] = mapped_column(String(32))  # answer being disputed
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open/confirmed/changed
    reviewer_answer: Mapped[str | None] = mapped_column(String(32))
    reviewer_reason: Mapped[str | None] = mapped_column(Text)
    reviewer_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    evaluation: Mapped[Evaluation] = relationship(back_populates="appeals")
    decision: Mapped[ReviewerDecision | None] = relationship(back_populates="appeal", uselist=False)


class ReviewerDecision(Base):
    """Audit record of a reviewer decision. The latest decision per criterion wins."""

    __tablename__ = "reviewer_decisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    appeal_id: Mapped[int] = mapped_column(ForeignKey("appeals.id"), unique=True)
    evaluation_id: Mapped[int] = mapped_column(ForeignKey("evaluations.id"), index=True)
    criterion_id: Mapped[str] = mapped_column(String(64))
    decision: Mapped[str] = mapped_column(String(16))  # confirmed / changed
    previous_answer: Mapped[str] = mapped_column(String(32))
    new_answer: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(Text)
    reviewer_id: Mapped[str] = mapped_column(String(100))
    score_before: Mapped[Decimal | None] = mapped_column(ExactDecimal)
    score_after: Mapped[Decimal | None] = mapped_column(ExactDecimal)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    appeal: Mapped[Appeal] = relationship(back_populates="decision")
    evaluation: Mapped[Evaluation] = relationship(back_populates="decisions")


# ------------------------------------------------------------------------ batch
class BatchJob(Base):
    __tablename__ = "batch_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str | None] = mapped_column(String(200))
    mode: Mapped[str] = mapped_column(String(16))  # submissions / conversations
    status: Mapped[str] = mapped_column(String(32), default="pending", index=True)
    checklist_version_id: Mapped[int | None] = mapped_column(ForeignKey("checklist_versions.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    items: Mapped[list[BatchItem]] = relationship(
        back_populates="batch_job", cascade="all, delete-orphan", order_by="BatchItem.id"
    )
    checklist_version: Mapped[ChecklistVersion | None] = relationship()


class BatchItem(Base):
    __tablename__ = "batch_items"
    __table_args__ = (
        UniqueConstraint("batch_job_id", "conversation_id", name="uq_batch_conversation"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_job_id: Mapped[int] = mapped_column(
        ForeignKey("batch_jobs.id", ondelete="CASCADE"), index=True
    )
    conversation_id: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending/succeeded/cached/failed
    evaluation_id: Mapped[int | None] = mapped_column(ForeignKey("evaluations.id"))
    error: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    batch_job: Mapped[BatchJob] = relationship(back_populates="items")


# -------------------------------------------------------------------- ingestion
class IngestionRun(Base):
    __tablename__ = "ingestion_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_kind: Mapped[str] = mapped_column(String(16))  # dev / control / upload
    group_id: Mapped[str] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(16))  # live / mock / upload
    status: Mapped[str] = mapped_column(String(16), default="running")  # running/succeeded/failed
    total_reported: Mapped[int | None] = mapped_column(Integer)
    fetched: Mapped[int] = mapped_column(Integer, default=0)
    created: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)  # identical duplicates
    conflicts: Mapped[int] = mapped_column(Integer, default=0)  # same id, different content
    failed: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[list] = mapped_column(JSON, default=list)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

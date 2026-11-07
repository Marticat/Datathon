from __future__ import annotations

from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.errors import NotFound, ValidationFailed
from app.models import Appeal, ChecklistVersion, Conversation, Evaluation, IngestionRun, Message

EVAL_STATUSES = {"evaluated", "not_evaluated", "appealed", "reviewed", "gross_error"}


def list_conversations(db: Session, *, q: str | None = None, channel: str | None = None,
                       language: str | None = None, dataset_group: str | None = None,
                       evaluation_status: str | None = None, page: int = 1, page_size: int = 20):
    stmt = select(Conversation)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(
            Conversation.conversation_id.ilike(like),
            exists().where(Message.conversation_pk == Conversation.id, Message.text.ilike(like)),
        ))
    if channel:
        ch = channel.lower()
        if ch not in ("chat", "call"):
            raise ValidationFailed("channel must be 'chat' or 'call'")
        stmt = stmt.where(Conversation.channel_type == ch)
    if language:
        stmt = stmt.where(Conversation.language == language.upper())
    if dataset_group:
        stmt = stmt.where(Conversation.dataset_group == dataset_group)
    if evaluation_status:
        if evaluation_status not in EVAL_STATUSES:
            raise ValidationFailed(f"evaluation_status must be one of {sorted(EVAL_STATUSES)}")
        has_eval = exists().where(Evaluation.conversation_pk == Conversation.id)
        if evaluation_status == "evaluated":
            stmt = stmt.where(has_eval)
        elif evaluation_status == "not_evaluated":
            stmt = stmt.where(~has_eval)
        elif evaluation_status == "appealed":
            stmt = stmt.where(exists().where(Evaluation.conversation_pk == Conversation.id,
                                             Appeal.evaluation_id == Evaluation.id, Appeal.status == "open"))
        elif evaluation_status == "reviewed":
            stmt = stmt.where(exists().where(Evaluation.conversation_pk == Conversation.id,
                                             Evaluation.status == "reviewed"))
        elif evaluation_status == "gross_error":
            stmt = stmt.where(exists().where(Evaluation.conversation_pk == Conversation.id,
                                             Evaluation.final_gross_error.is_(True)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Conversation.conversation_id).offset((page - 1) * page_size).limit(page_size))
    return list(rows), total


def get_conversation(db: Session, conversation_id: str) -> Conversation:
    c = db.scalar(select(Conversation).where(Conversation.conversation_id == conversation_id)
                  .options(selectinload(Conversation.messages)))
    if c is None:
        raise NotFound(f"Conversation {conversation_id!r} not found")
    return c


def _eval_brief(e: Evaluation, version_no: dict[int, int]) -> dict:
    return {"evaluation_id": e.id, "checklist_version": version_no[e.checklist_version_id], "status": e.status,
            "original_score": e.original_score, "final_score": e.final_score,
            "final_gross_error": e.final_gross_error, "created_at": e.created_at}


def summaries(db: Session, convs: list[Conversation], with_messages: bool = False) -> list[dict]:
    if not convs:
        return []
    pks = [c.id for c in convs]
    evals = db.scalars(select(Evaluation).where(Evaluation.conversation_pk.in_(pks)).order_by(Evaluation.id.desc())).all()
    version_no = dict(db.execute(select(ChecklistVersion.id, ChecklistVersion.version)).all())
    by_conv: dict[int, list[Evaluation]] = {}
    for e in evals:
        by_conv.setdefault(e.conversation_pk, []).append(e)
    first_client = dict(db.execute(
        select(Message.conversation_pk, func.min(Message.position))
        .where(Message.conversation_pk.in_(pks), Message.speaker == "client")
        .group_by(Message.conversation_pk)).all())
    previews = {}
    if first_client:
        for pk, pos, text in db.execute(select(Message.conversation_pk, Message.position, Message.text).where(
                Message.conversation_pk.in_(list(first_client)),
                Message.position.in_(list(set(first_client.values()))))).all():
            if first_client.get(pk) == pos:
                previews[pk] = text[:160]

    out = []
    for c in convs:
        ce = by_conv.get(c.id, [])
        d = {
            "conversation_id": c.conversation_id, "dataset_group": c.dataset_group, "channel": c.channel,
            "channel_type": c.channel_type, "language": c.language, "audio_url": c.audio_url,
            "message_count": c.message_count, "ingested_at": c.ingested_at, "evaluation_count": len(ce),
            "latest_evaluation": _eval_brief(ce[0], version_no) if ce else None,
            "preview": previews.get(c.id),
        }
        if with_messages:
            d["messages"] = [{"message_id": m.message_id, "position": m.position, "speaker": m.speaker,
                              "text": m.text, "timestamp_raw": m.timestamp_raw, "timestamp_kind": m.timestamp_kind,
                              "offset_seconds": m.offset_seconds} for m in c.messages]
            d["evaluations"] = [_eval_brief(e, version_no) for e in ce]
        out.append(d)
    return out


def ingestion_counts(db: Session) -> dict:
    def grouped(col):
        return {k or "unknown": v for k, v in db.execute(select(col, func.count()).group_by(col)).all()}
    return {
        "conversations_total": db.scalar(select(func.count()).select_from(Conversation)),
        "by_group": grouped(Conversation.dataset_group),
        "by_channel": grouped(Conversation.channel_type),
        "by_language": grouped(Conversation.language),
        "last_runs": list(db.scalars(select(IngestionRun).order_by(IngestionRun.id.desc()).limit(10))),
    }

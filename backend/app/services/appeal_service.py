from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.errors import Conflict, NotFound, ValidationFailed
from app.models import Appeal, Conversation, Evaluation, Message, ReviewerDecision, utcnow
from app.schemas.appeal import AppealCreate, AppealReview
from app.services import evaluation_service as es
from app.services.scoring import ScoringError, normalize_answer


def create_appeal(db: Session, data: AppealCreate) -> Appeal:
    ev = es.get_evaluation(db, data.evaluation_id)
    if data.criterion_id not in {r.criterion_id for r in ev.criterion_results}:
        raise ValidationFailed(f"Criterion {data.criterion_id!r} is not part of evaluation {ev.id}")
    if any(a.criterion_id == data.criterion_id and a.status == "open" for a in ev.appeals):
        raise Conflict(f"An open appeal already exists for criterion {data.criterion_id}")
    appeal = Appeal(
        evaluation_id=ev.id,
        criterion_id=data.criterion_id,
        user_comment=data.comment.strip(),
        created_by=data.created_by,
        original_answer=es.final_answers(ev)[data.criterion_id],
        status="open",
    )
    db.add(appeal)
    ev.appeals.append(appeal)
    es.refresh_eval_status(ev)
    db.commit()
    return get_appeal(db, appeal.id)


def review_appeal(db: Session, appeal_id: int, data: AppealReview) -> tuple[Appeal, dict]:
    appeal = get_appeal(db, appeal_id)
    if appeal.status != "open":
        raise Conflict(f"Appeal {appeal_id} was already reviewed ({appeal.status})")
    ev = es.get_evaluation(db, appeal.evaluation_id)
    spec = next(c for c in ev.checklist_version.criteria if c.criterion_id == appeal.criterion_id)
    current = es.final_answers(ev)[appeal.criterion_id]

    if data.decision == "confirm":
        new_answer = current
        if data.answer is not None and str(data.answer).strip():
            try:
                given = normalize_answer(data.answer, spec)
            except ScoringError as exc:
                raise ValidationFailed(str(exc), {"criterion_id": spec.criterion_id}) from None
            if given != current:
                raise ValidationFailed('decision "confirm" but answer differs from the current one; use "change"')
    else:
        try:
            new_answer = normalize_answer(data.answer, spec)
        except ScoringError as exc:
            raise ValidationFailed(str(exc), {"criterion_id": spec.criterion_id}) from None
        if new_answer == current:
            raise ValidationFailed('New answer equals the current answer; use decision "confirm"')

    score_before = ev.final_score
    decision = ReviewerDecision(
        appeal_id=appeal.id, evaluation_id=ev.id, criterion_id=appeal.criterion_id,
        decision="confirmed" if data.decision == "confirm" else "changed",
        previous_answer=current, new_answer=new_answer, reason=data.reason.strip(),
        reviewer_id=data.reviewer_id, score_before=score_before,
    )
    ev.decisions.append(decision)
    es.recompute_final(ev)  # original_score / CriterionResult rows stay untouched
    decision.score_after = ev.final_score

    appeal.status = decision.decision
    appeal.reviewer_answer = new_answer
    appeal.reviewer_reason = decision.reason
    appeal.reviewer_id = data.reviewer_id
    appeal.reviewed_at = utcnow()
    es.refresh_eval_status(ev)
    db.commit()
    return get_appeal(db, appeal.id), {
        "score_before": score_before, "score_after": ev.final_score,
        "original_score": ev.original_score, "final_gross_error": ev.final_gross_error,
    }


def get_appeal(db: Session, appeal_id: int) -> Appeal:
    a = db.scalar(select(Appeal).where(Appeal.id == appeal_id).options(*_LOAD))
    if a is None:
        raise NotFound(f"Appeal {appeal_id} not found")
    return a


_LOAD = (
    selectinload(Appeal.evaluation).selectinload(Evaluation.criterion_results),
    selectinload(Appeal.evaluation).selectinload(Evaluation.conversation),
    selectinload(Appeal.evaluation).selectinload(Evaluation.checklist_version),
)


def list_appeals(db: Session, *, status: str | None = None, evaluation_id: int | None = None,
                 conversation_id: str | None = None, criterion_id: str | None = None,
                 page: int = 1, page_size: int = 20) -> tuple[list[Appeal], int]:
    q = select(Appeal)
    if status:
        q = q.where(Appeal.status == status)
    if evaluation_id is not None:
        q = q.where(Appeal.evaluation_id == evaluation_id)
    if criterion_id:
        q = q.where(Appeal.criterion_id == criterion_id)
    if conversation_id:
        q = q.join(Evaluation).join(Conversation).where(Conversation.conversation_id == conversation_id)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    items = db.scalars(q.options(*_LOAD).order_by(Appeal.id.desc()).offset((page - 1) * page_size).limit(page_size))
    return list(items), total


def appeal_view(db: Session, a: Appeal) -> dict:
    ev = a.evaluation
    spec = next((c for c in ev.checklist_version.criteria if c.criterion_id == a.criterion_id), None)
    result = next(r for r in ev.criterion_results if r.criterion_id == a.criterion_id)
    msgs = {m.message_id: m for m in db.scalars(select(Message).where(
        Message.conversation_pk == ev.conversation_pk, Message.message_id.in_(result.evidence_message_ids or [""])))}
    return {
        "appeal_id": a.id, "evaluation_id": ev.id, "conversation_id": ev.conversation.conversation_id,
        "checklist_version": ev.checklist_version.version, "criterion_id": a.criterion_id,
        "criterion_name": spec.name if spec else a.criterion_id, "user_comment": a.user_comment,
        "created_by": a.created_by, "original_ai_answer": result.answer, "disputed_answer": a.original_answer,
        "ai_explanation": result.explanation,
        "evidence": [es.message_view(msgs[m]) for m in result.evidence_message_ids if m in msgs],
        "status": a.status, "reviewer_answer": a.reviewer_answer, "reviewer_reason": a.reviewer_reason,
        "reviewer_id": a.reviewer_id, "created_at": a.created_at, "reviewed_at": a.reviewed_at,
        "evaluation_original_score": ev.original_score, "evaluation_final_score": ev.final_score,
        "evaluation_final_gross_error": ev.final_gross_error,
    }

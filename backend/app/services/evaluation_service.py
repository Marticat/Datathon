"""Validation + storage of evaluation results submitted by the external AI module."""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.errors import NotFound, ValidationFailed
from app.models import (
    BatchItem,
    BatchJob,
    ChecklistVersion,
    Conversation,
    CriterionResult,
    Evaluation,
    Message,
    ReviewerDecision,
)
from app.schemas.evaluation import EvaluationSubmit
from app.services import checklist_service
from app.services.scoring import ScoreResult, ScoringError, calculate_score, normalize_answer

EVAL_LOAD = (
    selectinload(Evaluation.criterion_results),
    selectinload(Evaluation.checklist_version).selectinload(ChecklistVersion.criteria),
    selectinload(Evaluation.conversation),
    selectinload(Evaluation.appeals),
    selectinload(Evaluation.decisions),
)


def _payload_hash(conversation_id: str, version: int, rows: list[dict], gross: bool) -> str:
    canon = {"c": conversation_id, "v": version, "g": gross,
             "r": sorted(rows, key=lambda r: r["criterion_id"])}
    return hashlib.sha256(json.dumps(canon, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def validate_submission(db: Session, sub: EvaluationSubmit) -> tuple[Conversation, ChecklistVersion, list[dict], ScoreResult]:
    """Validate everything and return normalized rows + score. Raises ValidationFailed with ALL problems."""
    conv = db.scalar(select(Conversation).where(Conversation.conversation_id == sub.conversation_id))
    if conv is None:
        raise NotFound(f"Conversation {sub.conversation_id!r} not found", code="conversation_not_found")
    version = checklist_service.get_version(db, sub.checklist_version)
    specs = {c.criterion_id: c for c in version.criteria if c.is_active}
    message_ids = set(db.scalars(select(Message.message_id).where(Message.conversation_pk == conv.id)))

    errors: list[dict] = []
    submitted = {c.criterion_id for c in sub.criteria}
    for missing in sorted(set(specs) - submitted):
        errors.append({"criterion_id": missing, "field": "criterion_id", "error": "missing result for active criterion"})

    rows: list[dict] = []
    for c in sub.criteria:
        spec = specs.get(c.criterion_id)
        if spec is None:
            inactive = any(x.criterion_id == c.criterion_id for x in version.criteria)
            errors.append({"criterion_id": c.criterion_id, "field": "criterion_id",
                           "error": "criterion is inactive in this checklist version" if inactive
                           else f"unknown criterion for checklist version {version.version}"})
            continue
        try:
            answer = normalize_answer(c.answer, spec)
        except ScoringError as exc:
            errors.append({"criterion_id": c.criterion_id, "field": "answer", "error": str(exc)})
            continue
        evidence = list(dict.fromkeys(c.evidence_message_ids))  # dedupe, keep order
        bad = [m for m in evidence if m not in message_ids]
        if bad:
            errors.append({"criterion_id": c.criterion_id, "field": "evidence_message_ids",
                           "error": f"message ids not found in conversation {conv.conversation_id}: {bad}"})
            continue
        rows.append({"criterion_id": c.criterion_id, "answer": answer,
                     "explanation": c.explanation.strip(), "evidence_message_ids": evidence})

    if errors:
        raise ValidationFailed("Evaluation submission rejected", errors, code="invalid_submission")

    result = calculate_score(rows, version.criteria)
    has_gross_criterion = any(s.is_gross_error for s in specs.values())
    if has_gross_criterion and sub.gross_error is not None and sub.gross_error != result.gross_error:
        raise ValidationFailed(
            "gross_error flag contradicts the gross-error criterion answer",
            [{"field": "gross_error", "error": f"criterion says {result.gross_error}, payload says {sub.gross_error}"}],
            code="invalid_submission",
        )
    if not has_gross_criterion:
        result.gross_error = bool(sub.gross_error)
    return conv, version, rows, result


def submit_evaluation(db: Session, sub: EvaluationSubmit, *, commit: bool = True,
                      batch: BatchJob | None = None) -> tuple[Evaluation, bool]:
    """Store a validated submission. Returns (evaluation, created). Identical resubmissions are cached."""
    if sub.batch_id is not None and batch is None:
        batch = db.get(BatchJob, sub.batch_id)
        if batch is None:
            raise NotFound(f"Batch {sub.batch_id} not found")
    item = None
    if batch is not None and batch.mode == "conversations":
        item = db.scalar(select(BatchItem).where(BatchItem.batch_job_id == batch.id,
                                                 BatchItem.conversation_id == sub.conversation_id))
        if item is None:
            raise ValidationFailed(f"Conversation {sub.conversation_id!r} is not part of batch {batch.id}")
        if batch.checklist_version and batch.checklist_version.version != sub.checklist_version:
            raise ValidationFailed(
                f"Batch {batch.id} requires checklist_version {batch.checklist_version.version}")

    conv, version, rows, result = validate_submission(db, sub)
    h = _payload_hash(conv.conversation_id, version.version, rows, result.gross_error)

    existing = db.scalar(select(Evaluation).where(Evaluation.payload_hash == h).order_by(Evaluation.id))
    if existing is not None:
        ev, created = existing, False
    else:
        points = {r.criterion_id: r.points for r in result.criteria}
        ev = Evaluation(
            conversation_pk=conv.id,
            checklist_version_id=version.id,
            batch_job_id=batch.id if batch else None,
            source=sub.source,
            model_name=sub.model_name,
            status="completed",
            original_score=result.score,
            final_score=result.score,
            gross_error=result.gross_error,
            final_gross_error=result.gross_error,
            payload_hash=h,
            metadata_json=sub.metadata,
            criterion_results=[CriterionResult(**r, points_earned=points.get(r["criterion_id"])) for r in rows],
        )
        db.add(ev)
        db.flush()
        created = True

    if item is not None:
        item.status = "succeeded" if created else "cached"
        item.evaluation_id = ev.id
        item.error = None
        from app.services.batch_service import refresh_status
        refresh_status(db, batch)
    if commit:
        db.commit()
    return ev, created


# ------------------------------------------------------------------ reads
def get_evaluation(db: Session, evaluation_id: int) -> Evaluation:
    ev = db.scalar(select(Evaluation).where(Evaluation.id == evaluation_id).options(*EVAL_LOAD))
    if ev is None:
        raise NotFound(f"Evaluation {evaluation_id} not found")
    return ev


def list_evaluations(db: Session, *, conversation_id: str | None = None, checklist_version: int | None = None,
                     status: str | None = None, batch_id: int | None = None, gross_error: bool | None = None,
                     page: int = 1, page_size: int = 20) -> tuple[list[Evaluation], int]:
    q = select(Evaluation)
    if conversation_id:
        q = q.join(Conversation).where(Conversation.conversation_id == conversation_id)
    if checklist_version is not None:
        q = q.join(ChecklistVersion).where(ChecklistVersion.version == checklist_version)
    if status:
        q = q.where(Evaluation.status == status)
    if batch_id is not None:
        q = q.where(Evaluation.batch_job_id == batch_id)
    if gross_error is not None:
        q = q.where(Evaluation.final_gross_error.is_(gross_error))
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    items = db.scalars(q.options(*EVAL_LOAD).order_by(Evaluation.id.desc())
                       .offset((page - 1) * page_size).limit(page_size)).all()
    return list(items), total


def final_answers(ev: Evaluation) -> dict[str, str]:
    """Original answers with the latest reviewer decision per criterion applied."""
    answers = {r.criterion_id: r.answer for r in ev.criterion_results}
    for d in sorted(ev.decisions, key=lambda d: d.id):
        answers[d.criterion_id] = d.new_answer
    return answers


def original_answers(ev: Evaluation) -> dict[str, str]:
    return {r.criterion_id: r.answer for r in ev.criterion_results}


def recompute_final(ev: Evaluation) -> ScoreResult:
    result = calculate_score(final_answers(ev), ev.checklist_version.criteria)
    has_gross = any(c.is_gross_error and c.is_active for c in ev.checklist_version.criteria)
    if not has_gross:
        result.gross_error = ev.gross_error
    ev.final_score = result.score
    ev.final_gross_error = result.gross_error
    return result


def refresh_eval_status(ev: Evaluation) -> None:
    if any(a.status == "open" for a in ev.appeals):
        ev.status = "appealed"
    elif ev.decisions:
        ev.status = "reviewed"
    else:
        ev.status = "completed"


# ------------------------------------------------------------------ serialization
def _num(v):
    return None if v is None else Decimal(v)


def breakdown(result: ScoreResult) -> dict:
    return {
        "score": result.score,
        "earned_points": result.earned_points,
        "applicable_weight": result.applicable_weight,
        "total_weight": result.total_weight,
        "gross_error": result.gross_error,
        "criteria": [vars(c) for c in result.criteria],
        "sections": {k: {kk: (float(vv) if vv is not None else None) for kk, vv in v.items()}
                     for k, v in result.sections.items()},
    }


def summary(ev: Evaluation) -> dict:
    return {
        "evaluation_id": ev.id,
        "conversation_id": ev.conversation.conversation_id,
        "checklist_version": ev.checklist_version.version,
        "status": ev.status,
        "source": ev.source,
        "model_name": ev.model_name,
        "original_score": ev.original_score,
        "final_score": ev.final_score,
        "gross_error": ev.gross_error,
        "final_gross_error": ev.final_gross_error,
        "batch_id": ev.batch_job_id,
        "created_at": ev.created_at,
        "updated_at": ev.updated_at,
    }


def message_view(m: Message) -> dict:
    return {"message_id": m.message_id, "position": m.position, "speaker": m.speaker, "text": m.text,
            "timestamp_raw": m.timestamp_raw, "offset_seconds": m.offset_seconds}


def detail(db: Session, ev: Evaluation) -> dict:
    specs = {c.criterion_id: c for c in ev.checklist_version.criteria}
    orig = calculate_score(original_answers(ev), ev.checklist_version.criteria)
    final = calculate_score(final_answers(ev), ev.checklist_version.criteria)
    orig_by = {c.criterion_id: c for c in orig.criteria}
    final_by = {c.criterion_id: c for c in final.criteria}
    msgs = {m.message_id: m for m in db.scalars(select(Message).where(Message.conversation_pk == ev.conversation_pk))}
    open_appeals = {a.criterion_id: a.id for a in ev.appeals if a.status == "open"}

    criteria = []
    for r in sorted(ev.criterion_results, key=lambda r: specs[r.criterion_id].order):
        spec = specs[r.criterion_id]
        o, f = orig_by[r.criterion_id], final_by[r.criterion_id]
        criteria.append({
            "criterion_id": r.criterion_id,
            "name": spec.name,
            "section": spec.section,
            "weight": spec.weight,
            "scoring_type": spec.scoring_type,
            "is_gross_error": spec.is_gross_error,
            "original_answer": r.answer,
            "final_answer": f.answer,
            "overridden": f.answer != r.answer,
            "explanation": r.explanation,
            "evidence_message_ids": r.evidence_message_ids,
            "evidence": [message_view(msgs[m]) for m in r.evidence_message_ids if m in msgs],
            "original_points": o.points,
            "final_points": f.points,
            "final_effective_weight": f.effective_weight,
            "final_effective_points": f.effective_points,
            "open_appeal_id": open_appeals.get(r.criterion_id),
        })
    out = summary(ev)
    out["criteria"] = criteria
    out["sections"] = breakdown(final)["sections"]
    out["decisions"] = [decision_view(d) for d in ev.decisions]
    return out


def decision_view(d: ReviewerDecision) -> dict:
    return {
        "decision_id": d.id, "appeal_id": d.appeal_id, "criterion_id": d.criterion_id, "decision": d.decision,
        "previous_answer": d.previous_answer, "new_answer": d.new_answer, "reason": d.reason,
        "reviewer_id": d.reviewer_id,
        "score_before": None if d.score_before is None else float(d.score_before),
        "score_after": None if d.score_after is None else float(d.score_after),
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def score_view(ev: Evaluation) -> dict:
    orig = calculate_score(original_answers(ev), ev.checklist_version.criteria)
    final = calculate_score(final_answers(ev), ev.checklist_version.criteria)
    has_gross = any(c.is_gross_error and c.is_active for c in ev.checklist_version.criteria)
    if not has_gross:
        orig.gross_error = ev.gross_error
        final.gross_error = ev.final_gross_error
    return {
        "evaluation_id": ev.id,
        "checklist_version": ev.checklist_version.version,
        "original": breakdown(orig),
        "final": breakdown(final),
        "changed_by_review": original_answers(ev) != final_answers(ev),
    }

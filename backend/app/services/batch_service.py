"""Batch management for the control set (no AI here: results come from the AI module)."""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.errors import DomainError, NotFound, ValidationFailed
from app.models import BatchItem, BatchJob, ChecklistVersion, Conversation, Evaluation, utcnow
from app.schemas.evaluation import BatchCreate
from app.services import checklist_service
from app.services.evaluation_service import submit_evaluation


def refresh_status(db: Session, batch: BatchJob) -> None:
    db.flush()
    statuses = [i.status for i in batch.items]
    if not statuses:
        batch.status = "completed"
    elif "pending" in statuses:
        batch.status = "processing" if any(s != "pending" for s in statuses) else "pending"
    elif all(s == "failed" for s in statuses):
        batch.status = "failed"
    elif "failed" in statuses:
        batch.status = "completed_with_errors"
    else:
        batch.status = "completed"
    if batch.status not in ("pending", "processing") and batch.finished_at is None:
        batch.finished_at = utcnow()


def create_batch(db: Session, req: BatchCreate) -> BatchJob:
    if (req.submissions is None) == (req.conversation_ids is None):
        raise ValidationFailed("Provide exactly one of 'submissions' or 'conversation_ids'")

    if req.submissions is not None:
        return _create_from_submissions(db, req)
    return _create_from_conversations(db, req)


def _create_from_submissions(db: Session, req: BatchCreate) -> BatchJob:
    version = checklist_service.get_version(db, req.checklist_version) if req.checklist_version else None
    batch = BatchJob(name=req.name, mode="submissions", status="processing",
                     checklist_version_id=version.id if version else None)
    db.add(batch)
    db.flush()
    seen: set[str] = set()
    for sub in req.submissions:
        item = BatchItem(batch_job_id=batch.id, conversation_id=sub.conversation_id, status="pending")
        if sub.conversation_id in seen:
            # unique (batch, conversation): record the dup on the batch-level stats instead of a second row
            batch.items  # noqa: B018 - ensure loaded
            existing = next(i for i in batch.items if i.conversation_id == sub.conversation_id)
            existing.error = (existing.error or {}) | {"duplicate_in_batch": True}
            continue
        seen.add(sub.conversation_id)
        batch.items.append(item)
        if version and sub.checklist_version != version.version:
            item.status, item.error = "failed", {"message": f"batch requires checklist_version {version.version}"}
            continue
        sp = db.begin_nested()
        try:
            sub_no_batch = sub.model_copy(update={"batch_id": None})
            ev, created = submit_evaluation(db, sub_no_batch, commit=False)
            if created:
                ev.batch_job_id = batch.id
            sp.commit()
            item.status, item.evaluation_id = ("succeeded" if created else "cached"), ev.id
        except DomainError as exc:
            sp.rollback()
            item.status, item.error = "failed", {"code": exc.code, "message": exc.message, "details": exc.details}
    refresh_status(db, batch)
    db.commit()
    return get_batch(db, batch.id)


def _create_from_conversations(db: Session, req: BatchCreate) -> BatchJob:
    version = (checklist_service.get_version(db, req.checklist_version) if req.checklist_version
               else checklist_service.get_active(db))
    batch = BatchJob(name=req.name, mode="conversations", status="pending", checklist_version_id=version.id)
    db.add(batch)
    db.flush()
    for cid in dict.fromkeys(req.conversation_ids):  # dedupe, keep order
        item = BatchItem(batch_job_id=batch.id, conversation_id=cid, status="pending")
        batch.items.append(item)
        conv = db.scalar(select(Conversation).where(Conversation.conversation_id == cid))
        if conv is None:
            item.status, item.error = "failed", {"message": "conversation not found"}
            continue
        if req.reuse_existing:
            prev = db.scalar(select(Evaluation).where(Evaluation.conversation_pk == conv.id,
                                                      Evaluation.checklist_version_id == version.id)
                             .order_by(Evaluation.id.desc()))
            if prev is not None:
                item.status, item.evaluation_id = "cached", prev.id
    refresh_status(db, batch)
    db.commit()
    return get_batch(db, batch.id)


def get_batch(db: Session, batch_id: int) -> BatchJob:
    b = db.scalar(select(BatchJob).where(BatchJob.id == batch_id)
                  .options(selectinload(BatchJob.items), selectinload(BatchJob.checklist_version)))
    if b is None:
        raise NotFound(f"Batch {batch_id} not found")
    return b


def list_batches(db: Session) -> list[BatchJob]:
    return list(db.scalars(select(BatchJob).options(selectinload(BatchJob.items),
                                                    selectinload(BatchJob.checklist_version))
                           .order_by(BatchJob.id.desc())))


def batch_view(db: Session, b: BatchJob, include_items: bool = True) -> dict:
    eval_ids = [i.evaluation_id for i in b.items if i.evaluation_id]
    evals = {e.id: e for e in db.scalars(select(Evaluation).where(Evaluation.id.in_(eval_ids)))} if eval_ids else {}
    counts = {s: 0 for s in ("pending", "succeeded", "cached", "failed")}
    for i in b.items:
        counts[i.status] = counts.get(i.status, 0) + 1
    scores = [evals[i.evaluation_id].final_score for i in b.items
              if i.evaluation_id in evals and evals[i.evaluation_id].final_score is not None]
    avg = (sum(scores, Decimal(0)) / len(scores)).quantize(Decimal("0.01")) if scores else None
    stats = {
        "total": len(b.items), **counts,
        "completed": counts["succeeded"] + counts["cached"],
        "progress_pct": round(100 * (len(b.items) - counts["pending"]) / len(b.items), 1) if b.items else 100.0,
        "average_score": None if avg is None else float(avg),
        "gross_error_count": sum(1 for i in b.items if i.evaluation_id in evals and evals[i.evaluation_id].final_gross_error),
        "not_calculable_count": sum(1 for i in b.items if i.evaluation_id in evals and evals[i.evaluation_id].final_score is None),
    }
    return {
        "batch_id": b.id, "name": b.name, "mode": b.mode, "status": b.status,
        "checklist_version": b.checklist_version.version if b.checklist_version else None,
        "created_at": b.created_at, "finished_at": b.finished_at, "stats": stats,
        "items": [{"conversation_id": i.conversation_id, "status": i.status, "evaluation_id": i.evaluation_id,
                   "score": evals[i.evaluation_id].final_score if i.evaluation_id in evals else None,
                   "error": i.error} for i in b.items] if include_items else [],
    }

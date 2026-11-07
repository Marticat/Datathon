"""All REST endpoints under /api/v1."""
from math import ceil
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.errors import ValidationFailed
from app.schemas.appeal import AppealCreate, AppealOut, AppealReview, AppealReviewResult
from app.schemas.checklist import ChecklistOut, ChecklistUpdate, ChecklistVersionSummary
from app.schemas.common import Page
from app.schemas.conversation import (
    ControlIngestRequest,
    ConversationDetail,
    ConversationSummary,
    IngestionRunOut,
    IngestionStatus,
    UploadIngestRequest,
)
from app.schemas.evaluation import (
    BatchCreate,
    BatchOut,
    EvaluationOut,
    EvaluationSubmit,
    EvaluationSummary,
    ScoreOut,
    SubmitResponse,
)
from app.services import appeal_service, batch_service, checklist_service, conversation_service
from app.services import evaluation_service as es
from app.services import ingestion_service
from app.services.organizer_client import OrganizerClient

router = APIRouter(prefix="/api/v1")
PageNo = Query(1, ge=1, alias="page")
PageSize = Query(20, ge=1, le=200)


def page(items, total, page_no, size):
    return {"items": items, "total": total, "page": page_no, "page_size": size, "pages": ceil(total / size) if total else 0}


def get_organizer_client(settings: Settings = Depends(get_settings)) -> OrganizerClient:
    return OrganizerClient(settings)


def run_view(r) -> dict:
    return {"run_id": r.id, **{k: getattr(r, k) for k in (
        "dataset_kind", "group_id", "source", "status", "total_reported", "fetched", "created", "skipped",
        "conflicts", "failed", "errors", "started_at", "finished_at")}}


# ================================================================== ingestion
@router.post("/ingestion/dev", response_model=IngestionRunOut, tags=["ingestion"],
             summary="Download the DEV set (65 conversations) from the organizers' API")
def ingest_dev(db: Session = Depends(get_db), settings: Settings = Depends(get_settings),
               client: OrganizerClient = Depends(get_organizer_client)):
    run = ingestion_service.ingest_group(db, settings, kind="dev", group_id=settings.organizer_dev_group_id, client=client)
    return run_view(run)


@router.post("/ingestion/control", response_model=IngestionRunOut, tags=["ingestion"],
             summary="Download the control set (group_id announced by organizers)")
def ingest_control(body: ControlIngestRequest | None = None, db: Session = Depends(get_db),
                   settings: Settings = Depends(get_settings),
                   client: OrganizerClient = Depends(get_organizer_client)):
    group_id = (body.group_id if body and body.group_id else None) or settings.organizer_control_group_id
    if not group_id and not client.s.organizer_use_mock:
        raise ValidationFailed("Control group_id not configured yet. Pass {\"group_id\": \"...\"} or set "
                               "CQA_ORGANIZER_CONTROL_GROUP_ID.", code="control_group_unknown")
    run = ingestion_service.ingest_group(db, settings, kind="control", group_id=group_id or "CONTROL", client=client)
    return run_view(run)


@router.post("/ingestion/upload", response_model=IngestionRunOut, tags=["ingestion"],
             summary="Fallback: ingest a saved organizer JSON response (e.g. from curl)")
def ingest_upload(body: UploadIngestRequest, db: Session = Depends(get_db)):
    data = OrganizerClient._unwrap(body.payload)
    group_id = body.group_id or data.get("dataset_group_id") or "UPLOAD"
    run = ingestion_service.ingest_records(db, data["records"], group_id=group_id, kind="upload", source="upload",
                                           total_reported=data.get("total_records"))
    return run_view(run)


@router.get("/ingestion/status", response_model=IngestionStatus, tags=["ingestion"])
def ingestion_status(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    counts = conversation_service.ingestion_counts(db)
    counts["last_runs"] = [run_view(r) for r in counts["last_runs"]]
    return {"mode": "mock" if settings.organizer_use_mock else "live",
            "organizer_api_configured": bool(settings.organizer_api_url),
            "dev_group_id": settings.organizer_dev_group_id,
            "control_group_id": settings.organizer_control_group_id or None, **counts}


# ================================================================== checklist
@router.get("/checklist", response_model=ChecklistOut, tags=["checklist"], summary="Active checklist")
def get_checklist(version: int | None = Query(None, ge=1, description="Specific version instead of active"),
                  db: Session = Depends(get_db)):
    return checklist_service.get_version(db, version) if version else checklist_service.get_active(db)


@router.get("/checklist/versions", response_model=list[ChecklistVersionSummary], tags=["checklist"])
def checklist_versions(db: Session = Depends(get_db)):
    return [checklist_service.summary(v) for v in checklist_service.list_versions(db)]


@router.get("/checklist/versions/{version}", response_model=ChecklistOut, tags=["checklist"])
def checklist_version(version: int, db: Session = Depends(get_db)):
    return checklist_service.get_version(db, version)


@router.put("/checklist", response_model=ChecklistOut, tags=["checklist"],
            summary="Replace the checklist → creates and activates a new version (old ones are kept)")
def put_checklist(body: ChecklistUpdate, db: Session = Depends(get_db)):
    return checklist_service.create_version(db, body)


@router.post("/checklist/versions/{version}/activate", response_model=ChecklistOut, tags=["checklist"],
             summary="Roll back / switch the active checklist version")
def activate_checklist(version: int, db: Session = Depends(get_db)):
    return checklist_service.activate_version(db, version)


# ================================================================== evaluations
@router.post("/evaluations/submit", response_model=SubmitResponse, tags=["evaluations"],
             status_code=status.HTTP_201_CREATED,
             summary="AI module → backend: submit an evaluation result (validated, scored deterministically)",
             responses={200: {"description": "Identical submission already stored (duplicate=true)"},
                        404: {"description": "Conversation / checklist version / batch not found"},
                        422: {"description": "Invalid submission, see error.details"}})
def submit(body: EvaluationSubmit, response: Response, db: Session = Depends(get_db)):
    ev, created = es.submit_evaluation(db, body)
    if not created:
        response.status_code = status.HTTP_200_OK
    ev = es.get_evaluation(db, ev.id)
    return {"evaluation_id": ev.id, "conversation_id": ev.conversation.conversation_id,
            "checklist_version": ev.checklist_version.version, "score": ev.final_score,
            "gross_error": ev.final_gross_error, "status": ev.status, "duplicate": not created}


@router.post("/evaluations/validate", tags=["evaluations"],
             summary="Dry run: validate + score a submission without storing it")
def validate(body: EvaluationSubmit, db: Session = Depends(get_db)):
    _, _, _, result = es.validate_submission(db, body)
    return {"valid": True, **es.breakdown(result)}


@router.post("/evaluations/batch", response_model=BatchOut, status_code=201, tags=["batch"])
def create_batch(body: BatchCreate, db: Session = Depends(get_db)):
    return batch_service.batch_view(db, batch_service.create_batch(db, body))


@router.get("/evaluations/batch", response_model=list[BatchOut], tags=["batch"])
def list_batches(db: Session = Depends(get_db)):
    return [batch_service.batch_view(db, b, include_items=False) for b in batch_service.list_batches(db)]


@router.get("/evaluations/batch/{batch_id}", response_model=BatchOut, tags=["batch"])
def get_batch(batch_id: int, db: Session = Depends(get_db)):
    return batch_service.batch_view(db, batch_service.get_batch(db, batch_id))


@router.get("/evaluations", response_model=Page[EvaluationSummary], tags=["evaluations"])
def list_evaluations(conversation_id: str | None = None, checklist_version: int | None = None,
                     status_: Literal["completed", "appealed", "reviewed"] | None = Query(None, alias="status"),
                     batch_id: int | None = None, gross_error: bool | None = None,
                     page_no: int = PageNo, page_size: int = PageSize, db: Session = Depends(get_db)):
    items, total = es.list_evaluations(db, conversation_id=conversation_id, checklist_version=checklist_version,
                                       status=status_, batch_id=batch_id, gross_error=gross_error,
                                       page=page_no, page_size=page_size)
    return page([es.summary(e) for e in items], total, page_no, page_size)


@router.get("/evaluations/conversation/{conversation_id}", response_model=list[EvaluationOut], tags=["evaluations"],
            summary="All evaluations (history) of one conversation, newest first")
def evaluations_for_conversation(conversation_id: str, db: Session = Depends(get_db)):
    conversation_service.get_conversation(db, conversation_id)  # 404 if unknown
    items, _ = es.list_evaluations(db, conversation_id=conversation_id, page=1, page_size=1000)
    return [es.detail(db, e) for e in items]


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationOut, tags=["evaluations"])
def get_evaluation(evaluation_id: int, db: Session = Depends(get_db)):
    return es.detail(db, es.get_evaluation(db, evaluation_id))


@router.get("/evaluations/{evaluation_id}/score", response_model=ScoreOut, tags=["evaluations"],
            summary="Score breakdown: original (AI) vs final (after reviewer decisions)")
def get_score(evaluation_id: int, db: Session = Depends(get_db)):
    return es.score_view(es.get_evaluation(db, evaluation_id))


# ================================================================== appeals
@router.post("/appeals", response_model=AppealOut, status_code=201, tags=["appeals"])
def create_appeal(body: AppealCreate, db: Session = Depends(get_db)):
    return appeal_service.appeal_view(db, appeal_service.create_appeal(db, body))


@router.get("/appeals", response_model=Page[AppealOut], tags=["appeals"])
def list_appeals(status_: Literal["open", "confirmed", "changed"] | None = Query(None, alias="status"),
                 evaluation_id: int | None = None, conversation_id: str | None = None,
                 criterion_id: str | None = None, page_no: int = PageNo, page_size: int = PageSize,
                 db: Session = Depends(get_db)):
    items, total = appeal_service.list_appeals(db, status=status_, evaluation_id=evaluation_id,
                                               conversation_id=conversation_id, criterion_id=criterion_id,
                                               page=page_no, page_size=page_size)
    return page([appeal_service.appeal_view(db, a) for a in items], total, page_no, page_size)


@router.get("/appeals/{appeal_id}", response_model=AppealOut, tags=["appeals"])
def get_appeal(appeal_id: int, db: Session = Depends(get_db)):
    return appeal_service.appeal_view(db, appeal_service.get_appeal(db, appeal_id))


@router.post("/appeals/{appeal_id}/review", response_model=AppealReviewResult, tags=["appeals"],
             summary="Reviewer confirms or changes the answer (reason mandatory); score is recalculated")
def review_appeal(appeal_id: int, body: AppealReview, db: Session = Depends(get_db)):
    appeal, scores = appeal_service.review_appeal(db, appeal_id, body)
    return {"appeal": appeal_service.appeal_view(db, appeal), **scores}


# ================================================================== conversations
@router.get("/conversations", response_model=Page[ConversationSummary], tags=["conversations"])
def list_conversations(q: str | None = Query(None, description="Search in conversation id and message text"),
                       channel: Literal["chat", "call"] | None = None, language: str | None = None,
                       dataset_group: str | None = None,
                       evaluation_status: Literal["evaluated", "not_evaluated", "appealed", "reviewed",
                                                  "gross_error"] | None = None,
                       page_no: int = PageNo, page_size: int = PageSize, db: Session = Depends(get_db)):
    items, total = conversation_service.list_conversations(
        db, q=q, channel=channel, language=language, dataset_group=dataset_group,
        evaluation_status=evaluation_status, page=page_no, page_size=page_size)
    return page(conversation_service.summaries(db, items), total, page_no, page_size)


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail, tags=["conversations"])
def get_conversation(conversation_id: str, db: Session = Depends(get_db)):
    c = conversation_service.get_conversation(db, conversation_id)
    return conversation_service.summaries(db, [c], with_messages=True)[0]

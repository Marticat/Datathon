"""Turn organizer records into Conversation/Message rows (idempotent)."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.errors import Conflict
from app.models import Conversation, IngestionRun, Message, utcnow
from app.services.organizer_client import OrganizerClient

_MMSS = re.compile(r"^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.(\d+))?$")
VALID_SPEAKERS = {"client", "operator", "bot", "system"}


class RecordError(ValueError):
    pass


def content_hash(record: dict) -> str:
    return hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def channel_type(channel: str) -> str:
    c = (channel or "").lower()
    if "call" in c or "voice" in c:
        return "call"
    return "chat"


def parse_timestamp(raw) -> tuple[str, Decimal | None, datetime | None]:
    """Return (kind, mm:ss seconds, aware datetime). Raw string is always kept separately."""
    if raw is None or str(raw).strip() == "":
        return "unknown", None, None
    s = str(raw).strip()
    m = _MMSS.match(s)
    if m:
        h, mm, ss, frac = m.groups()
        secs = Decimal(int(h or 0) * 3600 + int(mm) * 60 + int(ss))
        if frac:
            secs += Decimal("0." + frac)
        return "mmss", secs, None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return "iso8601", None, dt
    except ValueError:
        return "unknown", None, None


def build_conversation(record: dict, group_id: str) -> Conversation:
    if not isinstance(record, dict):
        raise RecordError("record is not an object")
    cid = record.get("conversation_id")
    if not isinstance(cid, str) or not cid.strip():
        raise RecordError("conversation_id missing")
    transcript = record.get("transcript")
    if isinstance(transcript, str):  # defensive: the guide says it's already an array
        try:
            transcript = json.loads(transcript)
        except ValueError:
            raise RecordError(f"{cid}: transcript is not a JSON array") from None
    if not isinstance(transcript, list):
        raise RecordError(f"{cid}: transcript must be an array")

    conv = Conversation(
        conversation_id=cid.strip(),
        dataset_group=group_id,
        channel=str(record.get("channel") or ""),
        channel_type=channel_type(str(record.get("channel") or "")),
        language=(str(record["language"]).upper() if record.get("language") else None),
        audio_url=record.get("audio_url") or None,
        content_hash=content_hash(record),
        raw_record=record,
        message_count=len(transcript),
    )
    parsed = []
    for i, turn in enumerate(transcript):
        if not isinstance(turn, dict):
            raise RecordError(f"{cid}: transcript[{i}] is not an object")
        kind, secs, dt = parse_timestamp(turn.get("timestamp"))
        parsed.append((turn, kind, secs, dt))

    first_dt = next((dt for _, k, _, dt in parsed if k == "iso8601" and dt.tzinfo), None)
    for i, (turn, kind, secs, dt) in enumerate(parsed):
        offset = secs
        if kind == "iso8601" and first_dt is not None and dt.tzinfo is not None:
            offset = Decimal(str((dt - first_dt).total_seconds()))
        conv.messages.append(
            Message(
                message_id=f"m{i + 1}",
                position=i,
                speaker=str(turn.get("speaker") or "unknown").lower(),
                text=str(turn.get("text") or ""),
                timestamp_raw=None if turn.get("timestamp") is None else str(turn.get("timestamp")),
                timestamp_kind=kind,
                offset_seconds=offset,
            )
        )
    return conv


def ingest_records(db: Session, records: list, *, group_id: str, kind: str, source: str,
                   total_reported: int | None = None) -> IngestionRun:
    run = IngestionRun(dataset_kind=kind, group_id=group_id, source=source, total_reported=total_reported)
    db.add(run)
    db.flush()
    errors: list[dict] = []
    seen: set[str] = set()
    for idx, rec in enumerate(records):
        run.fetched += 1
        try:
            conv = build_conversation(rec, group_id)
        except RecordError as exc:
            run.failed += 1
            errors.append({"index": idx, "error": str(exc)})
            continue
        if conv.conversation_id in seen:
            run.skipped += 1
            errors.append({"conversation_id": conv.conversation_id, "error": "duplicate within payload"})
            continue
        seen.add(conv.conversation_id)
        existing = db.scalar(select(Conversation).where(Conversation.conversation_id == conv.conversation_id))
        if existing is not None:
            if existing.content_hash == conv.content_hash:
                run.skipped += 1
            else:
                # Never overwrite: evaluations reference existing message ids.
                run.conflicts += 1
                errors.append({"conversation_id": conv.conversation_id,
                               "error": "already stored with different content; kept original"})
            continue
        db.add(conv)
        run.created += 1
    run.errors = errors
    run.status = "succeeded"
    run.finished_at = utcnow()
    db.commit()
    db.refresh(run)
    return run


def ingest_group(db: Session, settings: Settings, *, kind: str, group_id: str,
                 client: OrganizerClient | None = None) -> IngestionRun:
    running = db.scalar(select(func.count()).select_from(IngestionRun).where(
        IngestionRun.status == "running", IngestionRun.group_id == group_id))
    if running:
        raise Conflict(f"Ingestion for group {group_id!r} is already running")
    client = client or OrganizerClient(settings)
    try:
        result = client.fetch(group_id)
    except Exception as exc:
        run = IngestionRun(dataset_kind=kind, group_id=group_id, source=client.mode, status="failed",
                           errors=[{"error": getattr(exc, "message", str(exc)), "details": getattr(exc, "details", None)}],
                           finished_at=utcnow())
        db.add(run)
        db.commit()
        raise
    return ingest_records(db, result.records, group_id=group_id, kind=kind, source=result.source,
                          total_reported=result.total_reported)

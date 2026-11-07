from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.errors import Conflict, NotFound
from app.models import ChecklistCriterion, ChecklistVersion
from app.schemas.checklist import ChecklistUpdate, CriterionIn

_COMPARE_FIELDS = (
    "name", "description", "section", "weight", "scoring_type", "allowed_values", "scale_labels",
    "na_allowed", "na_rule", "is_gross_error", "gross_error_config", "is_active",
)


def get_active(db: Session) -> ChecklistVersion:
    v = db.scalar(
        select(ChecklistVersion)
        .where(ChecklistVersion.is_active.is_(True))
        .options(selectinload(ChecklistVersion.criteria))
    )
    if v is None:
        raise NotFound("No active checklist configured")
    return v


def get_version(db: Session, version: int) -> ChecklistVersion:
    v = db.scalar(
        select(ChecklistVersion)
        .where(ChecklistVersion.version == version)
        .options(selectinload(ChecklistVersion.criteria))
    )
    if v is None:
        raise NotFound(f"Checklist version {version} not found")
    return v


def list_versions(db: Session) -> list[ChecklistVersion]:
    return list(
        db.scalars(
            select(ChecklistVersion)
            .options(selectinload(ChecklistVersion.criteria))
            .order_by(ChecklistVersion.version.desc())
        )
    )


def _changed(old: ChecklistCriterion, new: CriterionIn) -> bool:
    return any(getattr(old, f) != getattr(new, f) for f in _COMPARE_FIELDS)


def create_version(db: Session, data: ChecklistUpdate, created_by: str | None = None) -> ChecklistVersion:
    """Persist `data` as a new checklist version and make it the active one.

    Previous versions are never modified (only deactivated), so historical
    evaluations keep pointing at exactly the rules they were scored with.
    """
    current = db.scalar(
        select(ChecklistVersion)
        .where(ChecklistVersion.is_active.is_(True))
        .options(selectinload(ChecklistVersion.criteria))
    )
    if data.base_version is not None and (current is None or current.version != data.base_version):
        raise Conflict(
            "Checklist was modified concurrently",
            {"base_version": data.base_version, "active_version": current.version if current else None},
        )
    prev = {c.criterion_id: c for c in current.criteria} if current else {}
    next_no = (db.scalar(select(func.max(ChecklistVersion.version))) or 0) + 1

    db.execute(update(ChecklistVersion).values(is_active=False))
    version = ChecklistVersion(
        version=next_no,
        name=data.name,
        comment=data.comment,
        created_by=data.created_by or created_by,
        is_active=True,
    )
    for order, c in enumerate(data.criteria, start=1):
        old = prev.get(c.criterion_id)
        revision = 1 if old is None else (old.revision + 1 if _changed(old, c) else old.revision)
        version.criteria.append(
            ChecklistCriterion(
                criterion_id=c.criterion_id,
                order=order,
                name=c.name,
                description=c.description,
                section=c.section,
                weight=c.weight,
                scoring_type=c.scoring_type,
                allowed_values=c.allowed_values,
                scale_labels=c.scale_labels,
                na_allowed=c.na_allowed,
                na_rule=c.na_rule,
                is_gross_error=c.is_gross_error,
                gross_error_config=c.gross_error_config,
                is_active=c.is_active,
                revision=revision,
            )
        )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


def activate_version(db: Session, version: int) -> ChecklistVersion:
    v = get_version(db, version)
    db.execute(update(ChecklistVersion).values(is_active=False))
    v.is_active = True
    db.commit()
    db.refresh(v)
    return v


def summary(v: ChecklistVersion) -> dict:
    return {
        "version": v.version,
        "name": v.name,
        "comment": v.comment,
        "is_active": v.is_active,
        "created_by": v.created_by,
        "created_at": v.created_at,
        "criteria_count": len(v.criteria),
        "active_criteria_count": sum(1 for c in v.criteria if c.is_active),
    }

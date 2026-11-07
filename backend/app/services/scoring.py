"""Deterministic scoring engine. Pure Python + Decimal, no DB, no AI.

Rules (from the organizers' checklist, page 2 "Порядок расчёта"):
  1. N/A only where the criterion allows it.
  2. Binary: Yes = full weight, No = 0. Scaled: chosen step / top step * weight.
  3. The top step of a scale yields the full weight.
  4. N/A criteria are excluded; their weight is redistributed proportionally,
     the maximum stays 100.
  5. Final = 100 * earned / applicable, rounded to 2 decimals (ROUND_HALF_UP).
     If no weighted criterion is applicable the score is NOT calculated (None).
     Gross errors are a separate flag and never touch the score.

`calculate_score` is duck-typed: `checklist` may be ORM `ChecklistCriterion` rows or
`CriterionSpec` objects; `criteria_results` may be a {criterion_id: answer} mapping or
objects/dicts with `criterion_id` and `answer`.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

YES, NO, NA = "Yes", "No", "N/A"
BINARY, SCALED = "binary", "scaled"
HUNDRED = Decimal("100")
CENT = Decimal("0.01")

_ALIASES = {
    YES: {"yes", "y", "true", "да", "иә", "ия", "ие"},
    NO: {"no", "n", "false", "нет", "жоқ", "жок"},
    NA: {"n/a", "na", "n.a.", "н/д", "н/п", "not applicable", "неприменимо", "-"},
}


class ScoringError(ValueError):
    """Raised when answers cannot be scored against the checklist."""

    def __init__(self, message: str, criterion_id: str | None = None):
        super().__init__(message)
        self.criterion_id = criterion_id


@dataclass(frozen=True)
class CriterionSpec:
    criterion_id: str
    weight: Decimal
    scoring_type: str = BINARY
    allowed_values: tuple[str, ...] = (YES, NO)
    na_allowed: bool = False
    is_gross_error: bool = False
    is_active: bool = True
    section: str | None = None
    name: str = ""


@dataclass
class CriterionScore:
    criterion_id: str
    answer: str
    weight: Decimal  # configured weight
    is_na: bool
    counts_toward_score: bool  # False for N/A, gross-error and zero-weight criteria
    fraction: Decimal | None  # 0..1 share of the weight earned
    points: Decimal | None  # weight * fraction, before redistribution
    effective_weight: Decimal | None  # weight after N/A redistribution (sums to 100)
    effective_points: Decimal | None  # contribution to the final 100-point score
    section: str | None = None


@dataclass
class ScoreResult:
    score: Decimal | None  # None => not calculable (everything N/A)
    earned_points: Decimal
    applicable_weight: Decimal
    total_weight: Decimal
    gross_error: bool
    criteria: list[CriterionScore] = field(default_factory=list)
    sections: dict[str, dict[str, Decimal | None]] = field(default_factory=dict)

    @property
    def is_calculable(self) -> bool:
        return self.score is not None


def round2(value: Decimal | None) -> Decimal | None:
    return None if value is None else value.quantize(CENT, rounding=ROUND_HALF_UP)


def to_decimal(value: Any) -> Decimal:
    try:
        d = Decimal(str(value).strip().replace(",", "."))
    except (InvalidOperation, ValueError) as exc:
        raise ScoringError(f"Not a number: {value!r}") from exc
    if not d.is_finite():
        raise ScoringError(f"Not a finite number: {value!r}")
    return d


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def scale_values(spec: Any) -> list[Decimal]:
    return sorted(to_decimal(v) for v in (_get(spec, "allowed_values") or []))


def normalize_answer(raw: Any, spec: Any) -> str:
    """Return the canonical answer string for `spec` or raise ScoringError.

    Canonical forms: "Yes", "No", "N/A" or the allowed scale value as configured (e.g. "15").
    """
    cid = _get(spec, "criterion_id")
    if raw is None:
        raise ScoringError("Answer is missing", cid)
    if isinstance(raw, bool):
        raise ScoringError("Answer must be a string or number, not a boolean", cid)
    text = str(raw).strip()
    low = text.lower()

    if low in _ALIASES[NA]:
        if not _get(spec, "na_allowed", False):
            raise ScoringError("N/A is not permitted for this criterion", cid)
        return NA

    stype = _get(spec, "scoring_type", BINARY)
    if stype == BINARY:
        for canonical in (YES, NO):
            if low in _ALIASES[canonical]:
                return canonical
        raise ScoringError(f"Invalid answer {text!r}; expected Yes/No" + ("/N/A" if _get(spec, "na_allowed") else ""), cid)

    if stype == SCALED:
        try:
            value = to_decimal(text)
        except ScoringError:
            raise ScoringError(f"Invalid answer {text!r}; expected one of {list(_get(spec, 'allowed_values'))}", cid) from None
        for allowed in _get(spec, "allowed_values") or []:
            if to_decimal(allowed) == value:
                return str(allowed)
        raise ScoringError(f"Invalid scale value {text!r}; allowed: {list(_get(spec, 'allowed_values'))}", cid)

    raise ScoringError(f"Unknown scoring type {stype!r}", cid)


def _fraction(answer: str, spec: Any) -> Decimal:
    stype = _get(spec, "scoring_type", BINARY)
    if stype == BINARY:
        return Decimal(1) if answer == YES else Decimal(0)
    top = scale_values(spec)[-1]
    if top <= 0:
        raise ScoringError("Scale maximum must be positive", _get(spec, "criterion_id"))
    return to_decimal(answer) / top


def _answers_map(criteria_results: Any) -> dict[str, Any]:
    if isinstance(criteria_results, Mapping):
        return dict(criteria_results)
    out: dict[str, Any] = {}
    for item in criteria_results:
        cid = _get(item, "criterion_id")
        if cid in out:
            raise ScoringError("Duplicate criterion result", cid)
        out[cid] = _get(item, "answer")
    return out


def calculate_score(criteria_results: Any, checklist: Iterable[Any]) -> ScoreResult:
    """Compute the final score. Inactive criteria in `checklist` are ignored."""
    specs = [c for c in checklist if _get(c, "is_active", True)]
    answers = _answers_map(criteria_results)

    known = {_get(s, "criterion_id") for s in specs}
    unknown = sorted(set(answers) - known)
    if unknown:
        raise ScoringError(f"Unknown criterion ids: {unknown}", unknown[0])

    rows: list[CriterionScore] = []
    earned = Decimal(0)
    applicable = Decimal(0)
    total = Decimal(0)
    gross = False

    for spec in specs:
        cid = _get(spec, "criterion_id")
        if cid not in answers:
            raise ScoringError("Missing result for criterion", cid)
        answer = normalize_answer(answers[cid], spec)
        weight = to_decimal(_get(spec, "weight", 0))
        is_gross = bool(_get(spec, "is_gross_error", False))
        is_na = answer == NA

        if is_gross:
            gross = gross or answer == YES
        scored = (not is_gross) and weight > 0
        if scored:
            total += weight

        frac = pts = None
        if scored and not is_na:
            frac = _fraction(answer, spec)
            pts = weight * frac
            earned += pts
            applicable += weight

        rows.append(
            CriterionScore(
                criterion_id=cid,
                answer=answer,
                weight=weight,
                is_na=is_na,
                counts_toward_score=scored and not is_na,
                fraction=frac,
                points=pts,
                effective_weight=None,
                effective_points=None,
                section=_get(spec, "section"),
            )
        )

    score: Decimal | None = None
    if applicable > 0:
        score = round2(HUNDRED * earned / applicable)
        for r in rows:
            if r.counts_toward_score:
                r.effective_weight = round2(r.weight * HUNDRED / applicable)
                r.effective_points = round2(r.points * HUNDRED / applicable)

    sections: dict[str, dict[str, Decimal | None]] = {}
    for r in rows:
        if r.section is None or not (r.weight > 0):
            continue
        s = sections.setdefault(r.section, {"earned": Decimal(0), "applicable": Decimal(0)})
        if r.counts_toward_score:
            s["earned"] += r.points
            s["applicable"] += r.weight
    for s in sections.values():
        s["score"] = round2(HUNDRED * s["earned"] / s["applicable"]) if s["applicable"] > 0 else None

    return ScoreResult(
        score=score,
        earned_points=earned,
        applicable_weight=applicable,
        total_weight=total,
        gross_error=gross,
        criteria=rows,
        sections=sections,
    )

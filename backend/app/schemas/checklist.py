from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.common import DecimalNum, ORMModel

CRITERION_ID_PATTERN = r"^[A-Za-z0-9_.\-]{1,64}$"


class CriterionIn(BaseModel):
    criterion_id: str = Field(pattern=CRITERION_ID_PATTERN, examples=["C01"])
    name: str = Field(min_length=1, max_length=300)
    description: str = ""
    section: str | None = None
    weight: Decimal = Field(ge=0, le=100, examples=["10"])
    scoring_type: Literal["binary", "scaled"]
    allowed_values: list[str] | None = Field(
        default=None, description="binary: [\"Yes\",\"No\"] (default). scaled: numeric steps, e.g. [\"0\",\"5\",\"10\"]"
    )
    scale_labels: dict[str, str] = Field(default_factory=dict, description="scale value -> description")
    na_allowed: bool = False
    na_rule: str | None = None
    is_gross_error: bool = False
    gross_error_config: dict = Field(default_factory=dict)
    is_active: bool = True

    @field_validator("allowed_values", mode="before")
    @classmethod
    def _stringify(cls, v):
        return None if v is None else [str(x).strip() for x in v]

    @model_validator(mode="after")
    def _check(self):
        if self.scoring_type == "binary":
            if self.allowed_values is None:
                self.allowed_values = ["Yes", "No"]
            if sorted(self.allowed_values) != ["No", "Yes"]:
                raise ValueError("binary criteria must have allowed_values exactly [\"Yes\", \"No\"]")
            if self.scale_labels:
                raise ValueError("scale_labels are only valid for scaled criteria")
        else:
            if not self.allowed_values or len(self.allowed_values) < 2:
                raise ValueError("scaled criteria need at least two allowed numeric values")
            try:
                nums = [Decimal(v) for v in self.allowed_values]
            except InvalidOperation:
                raise ValueError("scaled allowed_values must be numeric strings") from None
            if any(n < 0 or not n.is_finite() for n in nums):
                raise ValueError("scaled allowed_values must be finite and >= 0")
            if len(set(nums)) != len(nums):
                raise ValueError("scaled allowed_values must be unique")
            if max(nums) <= 0:
                raise ValueError("scale maximum must be > 0")
            # canonical ascending order
            self.allowed_values = [v for _, v in sorted(zip(nums, self.allowed_values))]
            unknown = set(self.scale_labels) - set(self.allowed_values)
            if unknown:
                raise ValueError(f"scale_labels keys not in allowed_values: {sorted(unknown)}")
        if self.is_gross_error:
            if self.scoring_type != "binary":
                raise ValueError("gross-error criteria must be binary (Yes = gross error detected)")
            if self.weight != 0:
                raise ValueError("gross-error criteria must have weight 0 (they never affect the score)")
            if self.na_allowed:
                raise ValueError("gross-error criteria cannot allow N/A")
        if not self.na_allowed and self.na_rule:
            raise ValueError("na_rule given but na_allowed is false")
        return self


class ChecklistUpdate(BaseModel):
    """Full replacement of the checklist. Creates (and activates) a new version."""

    name: str = Field(min_length=1, max_length=200)
    comment: str | None = None
    created_by: str | None = None
    base_version: int | None = Field(
        default=None, description="Optional optimistic lock: reject if the active version changed meanwhile"
    )
    criteria: list[CriterionIn] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self):
        ids = [c.criterion_id for c in self.criteria]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate criterion_id: {dupes}")
        active_scored = [c for c in self.criteria if c.is_active and not c.is_gross_error]
        if not active_scored:
            raise ValueError("at least one active scored criterion is required")
        total = sum((c.weight for c in active_scored), Decimal(0))
        if total != Decimal(100):
            raise ValueError(f"active criterion weights must total 100, got {total}")
        return self


class CriterionOut(ORMModel):
    criterion_id: str
    order: int
    name: str
    description: str
    section: str | None
    weight: DecimalNum
    scoring_type: str
    allowed_values: list[str]
    scale_labels: dict[str, str]
    na_allowed: bool
    na_rule: str | None
    is_gross_error: bool
    gross_error_config: dict
    is_active: bool
    revision: int


class ChecklistOut(ORMModel):
    version: int
    name: str
    comment: str | None
    is_active: bool
    created_by: str | None
    created_at: datetime
    criteria: list[CriterionOut]


class ChecklistVersionSummary(ORMModel):
    version: int
    name: str
    comment: str | None
    is_active: bool
    created_by: str | None
    created_at: datetime
    criteria_count: int
    active_criteria_count: int

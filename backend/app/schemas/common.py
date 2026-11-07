from decimal import Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, PlainSerializer

T = TypeVar("T")

# Decimals are serialized as JSON numbers (e.g. 87.5) — exact values are kept server-side.
DecimalNum = Annotated[Decimal, PlainSerializer(lambda v: float(v), return_type=float, when_used="json")]
OptDecimalNum = Annotated[
    Decimal | None,
    PlainSerializer(lambda v: None if v is None else float(v), return_type=float | None, when_used="json"),
]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int

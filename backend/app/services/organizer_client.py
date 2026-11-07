"""Adapter for the organizers' temporary API.

Documented contract (Student Guide, page 3):
  GET <url>?group_id=<GROUP>  ->
  {"error": "", "isSuccess": true,
   "data": {"dataset_group_id": "DEV", "total_records": 65, "records": [...]}}

The real URL is not published in the guide, so it is configured via CQA_ORGANIZER_API_URL.
Without it the adapter runs in mock mode using bundled sample data (clearly marked MOCK).
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import Settings
from app.errors import UpstreamError

log = logging.getLogger(__name__)
MOCK_DIR = Path(__file__).resolve().parent.parent / "mock_data"


@dataclass
class FetchResult:
    group_id: str
    records: list[dict]
    total_reported: int | None
    source: str  # live / mock


class OrganizerClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None, sleep=time.sleep):
        self.s = settings
        self.transport = transport
        self.sleep = sleep

    @property
    def mode(self) -> str:
        return "mock" if self.s.organizer_use_mock else "live"

    def fetch(self, group_id: str) -> FetchResult:
        if self.s.organizer_use_mock:
            return self._fetch_mock(group_id)
        return self._fetch_live(group_id)

    # ------------------------------------------------------------------ mock
    def _fetch_mock(self, group_id: str) -> FetchResult:
        path = MOCK_DIR / ("dev_mock.json" if group_id.upper() == "DEV" else "control_mock.json")
        payload = json.loads(path.read_text(encoding="utf-8"))
        data = self._unwrap(payload)
        return FetchResult(group_id, data["records"], data.get("total_records"), "mock")

    # ------------------------------------------------------------------ live
    def _get(self, client: httpx.Client, params: dict) -> dict:
        last_exc: Exception | None = None
        for attempt in range(self.s.organizer_max_retries + 1):
            try:
                resp = client.get(self.s.organizer_api_url, params=params)
                if resp.status_code >= 500 or resp.status_code == 429:
                    raise httpx.HTTPStatusError(f"HTTP {resp.status_code}", request=resp.request, response=resp)
                if resp.status_code >= 400:
                    raise UpstreamError(
                        f"Organizer API returned HTTP {resp.status_code}", {"body": resp.text[:500]}
                    )
                try:
                    return resp.json()
                except ValueError:
                    raise UpstreamError("Organizer API returned non-JSON body", {"body": resp.text[:500]}) from None
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                last_exc = exc
                if attempt < self.s.organizer_max_retries:
                    delay = 0.5 * (2**attempt)
                    log.warning("organizer API attempt %s failed (%s); retrying in %.1fs", attempt + 1, exc, delay)
                    self.sleep(delay)
        raise UpstreamError(
            f"Organizer API unreachable after {self.s.organizer_max_retries + 1} attempts", {"reason": str(last_exc)}
        )

    @staticmethod
    def _unwrap(payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise UpstreamError("Unexpected organizer response shape (not an object)")
        if payload.get("isSuccess") is not True:
            raise UpstreamError("Organizer API reported failure", {"error": payload.get("error")})
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("records"), list):
            raise UpstreamError("Unexpected organizer response shape (data.records missing)")
        return data

    def _fetch_live(self, group_id: str) -> FetchResult:
        base = {self.s.organizer_group_param: group_id}
        records: list[dict] = []
        total: int | None = None
        with httpx.Client(timeout=self.s.organizer_timeout_seconds, transport=self.transport) as client:
            if not self.s.organizer_page_param:
                data = self._unwrap(self._get(client, base))
                return FetchResult(group_id, data["records"], data.get("total_records"), "live")
            page = 1
            while True:
                params = dict(base, **{self.s.organizer_page_param: page})
                if self.s.organizer_page_size_param:
                    params[self.s.organizer_page_size_param] = self.s.organizer_page_size
                data = self._unwrap(self._get(client, params))
                batch = data["records"]
                total = data.get("total_records", total)
                records.extend(batch)
                if not batch or (total is not None and len(records) >= total) or len(batch) < self.s.organizer_page_size:
                    break
                page += 1
                if page > 1000:  # safety valve
                    break
        return FetchResult(group_id, records, total, "live")

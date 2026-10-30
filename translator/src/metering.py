"""Per-session usage counters and cost estimation (no audio, no text)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from config import Settings


def iso_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct / 100.0
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


@dataclass
class SessionMeter:
    speaker_id: str
    target_lang: str
    provider: str
    input_seconds: float = 0.0
    output_seconds: float = 0.0
    session_seconds: float = 0.0
    errors: int = 0
    first_audio_ms: list[float] = field(default_factory=list)
    all_first_audio_ms: list[float] = field(default_factory=list)
    period_start: float = field(default_factory=time.time)
    _connected_since: float | None = None

    def mark_connected(self, now: float | None = None) -> None:
        if self._connected_since is None:
            self._connected_since = time.monotonic() if now is None else now

    def mark_disconnected(self, now: float | None = None) -> None:
        if self._connected_since is not None:
            now = time.monotonic() if now is None else now
            self.session_seconds += max(0.0, now - self._connected_since)
            self._connected_since = None

    def add_first_audio(self, ms: float) -> None:
        self.first_audio_ms.append(ms)
        self.all_first_audio_ms.append(ms)
        if len(self.all_first_audio_ms) > 200:
            del self.all_first_audio_ms[:-200]

    def is_empty(self) -> bool:
        return (
            self.input_seconds == 0
            and self.output_seconds == 0
            and self.session_seconds == 0
            and self._connected_since is None
            and self.errors == 0
            and not self.first_audio_ms
        )

    def take_record(self, now_wall: float | None = None) -> dict:
        """Return the usage record for the elapsed period and reset counters."""
        now_wall = time.time() if now_wall is None else now_wall
        if self._connected_since is not None:
            mono = time.monotonic()
            self.session_seconds += max(0.0, mono - self._connected_since)
            self._connected_since = mono
        record = {
            "speakerId": self.speaker_id,
            "targetLang": self.target_lang,
            "provider": self.provider,
            "inputSeconds": round(self.input_seconds, 3),
            "outputSeconds": round(self.output_seconds, 3),
            "sessionSeconds": round(self.session_seconds, 3),
            "periodStart": iso_utc(self.period_start),
            "periodEnd": iso_utc(now_wall),
            "errors": self.errors,
            "firstAudioMs": [round(x) for x in self.first_audio_ms],
        }
        self.input_seconds = 0.0
        self.output_seconds = 0.0
        self.session_seconds = 0.0
        self.errors = 0
        self.first_audio_ms = []
        self.period_start = now_wall
        return record


def estimate_cost_usd(record: dict, settings: Settings) -> float:
    """Same model as CONTRACT.md §7 (the control plane is authoritative)."""
    provider = record.get("provider")
    if provider == "gemini":
        return (
            record.get("inputSeconds", 0) / 60 * settings.gemini_input_usd_per_min
            + record.get("outputSeconds", 0) / 60 * settings.gemini_output_usd_per_min
        )
    if provider == "openai":
        return record.get("sessionSeconds", 0) / 60 * settings.openai_usd_per_min
    return 0.0

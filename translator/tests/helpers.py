"""Shared test helpers: synthetic speech-like audio, fake rooms and control plane."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
from livekit import rtc

from config import Settings
from control_plane import (
    AdmissionDecision,
    AdmissionResult,
    ControlPlaneError,
    TranslationPolicy,
    UsageResult,
)

FAST = Settings(
    gate_pre_roll_ms=200,
    gate_hangover_ms=600,
    session_grace_sec=0.2,
    reconnect_backoff_sec=(0.0, 0.05, 0.1, 0.2),
    reconcile_debounce_sec=0.02,
    idle_shutdown_sec=0.5,
    stats_interval_sec=0.3,
    usage_interval_sec=0.2,
    admission_debounce_sec=0.01,
    admission_reverify_sec=0.3,
    admission_fail_closed_sec=0.4,
    caption_segment_gap_sec=0.5,
    rotation_drain_sec=0.3,
    delayed_no_output_sec=2.0,
    mock_delay_ms=300,
    mock_chunk_ms=50,
)


def fast(**overrides: Any) -> Settings:
    return replace(FAST, **overrides)


def speech_like(
    duration_s: float, *, rate: int = 48000, seed: int = 0, level: float = 0.25
) -> np.ndarray:
    """Harmonic voiced signal with syllable-rate amplitude modulation (int16)."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * rate)
    t = np.arange(n) / rate
    f0 = 120 + 80 * rng.random()
    vib = 1 + 0.03 * np.sin(2 * np.pi * 5 * t)
    sig = np.zeros(n)
    for h in range(1, 8):
        sig += (1.0 / h) * np.sin(2 * np.pi * f0 * h * vib * t + rng.random() * 6.28)
    env = np.zeros(n)
    pos = 0
    while pos < n:
        syl = int(rate * (0.12 + 0.18 * rng.random()))
        gap = int(rate * (0.03 + 0.08 * rng.random()))
        end = min(n, pos + syl)
        env[pos:end] = np.hanning(max(2, end - pos))[: end - pos]
        pos = end + gap
    sig = sig * env
    sig = sig / (np.max(np.abs(sig)) + 1e-9) * level * 32767
    return sig.astype(np.int16)


def silence(
    duration_s: float, *, rate: int = 48000, noise: float = 30.0, seed: int = 1
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.normal(0, noise, int(duration_s * rate))).astype(np.int16)


def frames_of(
    samples: np.ndarray, *, rate: int = 48000, frame_ms: int = 10
) -> list[bytes]:
    step = rate * frame_ms // 1000
    return [
        samples[i : i + step].tobytes() for i in range(0, len(samples) - step + 1, step)
    ]


async def paced(
    frames: list[bytes], *, frame_ms: int = 10, start_delay: float = 0.0
) -> AsyncIterator[bytes]:
    """Yield frames at real-time pace (absolute schedule, robust to timer jitter)."""
    if start_delay:
        await asyncio.sleep(start_delay)
    t0 = time.monotonic()
    for i, f in enumerate(frames):
        target = t0 + i * frame_ms / 1000
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        yield f


async def paced_then_silence(
    frames: list[bytes], *, start_delay: float = 0.0, tail_s: float = 30.0
) -> AsyncIterator[bytes]:
    async for f in paced(frames, start_delay=start_delay):
        yield f
    async for f in paced(frames_of(silence(tail_s))):
        yield f


def rms(pcm: bytes) -> float:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    return float(np.sqrt(np.mean(x * x))) if x.size else 0.0


# --- Fake LiveKit room ---------------------------------------------------------


@dataclass
class FakeTrack:
    name: str
    kind: int = rtc.TrackKind.KIND_AUDIO


@dataclass
class FakePub:
    track: FakeTrack | None
    muted: bool = False
    kind: int = rtc.TrackKind.KIND_AUDIO


@dataclass
class FakeParticipant:
    identity: str
    attributes: dict[str, str]
    kind: int = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    track_publications: dict[str, FakePub] = field(default_factory=dict)


def human(
    identity: str,
    speak: str,
    listen: str,
    *,
    epoch: str = "1",
    mic: bool = True,
    muted: bool = False,
) -> FakeParticipant:
    p = FakeParticipant(
        identity=identity,
        attributes={
            "speak_lang": speak,
            "listen_lang": listen,
            "epoch": epoch,
            "interp.v": "1",
        },
    )
    if mic:
        p.track_publications["MIC_" + identity] = FakePub(
            track=FakeTrack(name="mic-" + identity), muted=muted
        )
    return p


class FakeRoom:
    def __init__(
        self, name: str = "grp_test", participants: list[FakeParticipant] | None = None
    ) -> None:
        self.name = name
        self.remote_participants: dict[str, FakeParticipant] = {
            p.identity: p for p in participants or []
        }
        self.handlers: dict[str, list] = {}

    def on(self, event: str):
        def deco(fn):
            self.handlers.setdefault(event, []).append(fn)
            return fn

        return deco

    def emit(self, event: str, *args: Any) -> None:
        for fn in self.handlers.get(event, []):
            fn(*args)

    def add(self, p: FakeParticipant) -> None:
        self.remote_participants[p.identity] = p
        self.emit("participant_connected", p)
        for pub in p.track_publications.values():
            if pub.track is not None:
                self.emit("track_subscribed", pub.track, pub, p)

    def remove(self, identity: str) -> None:
        p = self.remote_participants.pop(identity)
        self.emit("participant_disconnected", p)


# --- Fake control plane -----------------------------------------------------------


class FakeControlPlane:
    def __init__(self) -> None:
        self.standalone = False
        self.denied: dict[str, str] = {}
        self.epochs: dict[str, int] = {}
        self.translation = TranslationPolicy(True, None, None)
        self.usage_translation = TranslationPolicy(True, None, None)
        self.fail = False
        self.room_unknown = False
        self.admission_calls: list[list[str]] = []
        self.usage_calls: list[dict] = []

    async def admission(self, *, room: str, identities: list[str]) -> AdmissionResult:
        self.admission_calls.append(list(identities))
        if self.fail:
            raise ControlPlaneError("down")
        if self.room_unknown:
            return AdmissionResult(
                participants={
                    i: AdmissionDecision(False, None, "unknown_room")
                    for i in identities
                },
                translation=TranslationPolicy(False, "unknown_room"),
                room_unknown=True,
            )
        res = AdmissionResult(
            gathering_id="g1", group_id="grp1", translation=self.translation
        )
        for i in identities:
            if i in self.denied:
                res.participants[i] = AdmissionDecision(False, None, self.denied[i])
            else:
                res.participants[i] = AdmissionDecision(
                    True, self.epochs.get(i, 1), None
                )
        return res

    async def usage(
        self, *, room: str, gathering_id: str, group_id: str, records: list[dict]
    ) -> UsageResult:
        self.usage_calls.append({"room": room, "records": records})
        if self.fail:
            raise ControlPlaneError("down")
        return UsageResult(
            translation=self.usage_translation,
            spend={"gatheringUsd": 0.0, "capGatheringUsd": 50},
        )

    async def aclose(self) -> None:
        return None


async def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()

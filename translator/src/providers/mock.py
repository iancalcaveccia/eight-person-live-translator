"""Deterministic mock provider for tests and local end-to-end runs.

It behaves like a streaming translator: every input chunk is re-emitted as
output audio `delay_ms` later (real-time paced), so output starts while input
is still flowing. It also emits fake transcripts and supports failure
injection. It costs nothing and never leaves the machine.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from array import array
from collections.abc import AsyncIterator

from providers.base import (
    MOCK_TARGETS,
    AudioOut,
    GoAway,
    ProviderCapabilities,
    ProviderError,
    ProviderEvent,
    ProviderStream,
    SegmentEnd,
    StreamClosed,
    StreamError,
    TranscriptOut,
    TranslationProvider,
)

_WORDS = {
    "en": ["hello", "friends", "this", "is", "a", "mock", "translation"],
    "pl": ["cześć", "przyjaciele", "to", "jest", "próbne", "tłumaczenie"],
    "es": ["hola", "amigos", "esta", "es", "una", "traducción", "simulada"],
}


def _rms(pcm: bytes) -> float:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0.0
    return (sum(s * s for s in samples) / len(samples)) ** 0.5


class MockStream(ProviderStream):
    def __init__(
        self,
        *,
        target_lang: str,
        sample_rate: int,
        delay_ms: int,
        drop_after_sec: float | None,
        goaway_after_sec: float | None,
        speech_rms_threshold: float = 300.0,
    ) -> None:
        self._target = target_lang
        self._rate = sample_rate
        self._delay = delay_ms / 1000.0
        self._drop_after = drop_after_sec
        self._goaway_after = goaway_after_sec
        self._threshold = speech_rms_threshold
        self._pending: asyncio.Queue[tuple[float, bytes] | None] = asyncio.Queue()
        self._events: asyncio.Queue[ProviderEvent] = asyncio.Queue()
        self._closed = False
        self._opened_at = time.monotonic()
        self._speech_accum = 0.0
        self._silence_accum = 0.0
        self._in_segment = False
        self._word_idx = 0
        self.received_chunks = 0
        self.received_seconds = 0.0
        self._task = asyncio.create_task(self._emit_loop(), name="mock-emit")
        self._timer_task = asyncio.create_task(self._timers(), name="mock-timers")

    async def send_audio(self, pcm: bytes) -> None:
        if self._closed:
            raise ProviderError("mock stream closed")
        now = time.monotonic()
        self.received_chunks += 1
        dur = len(pcm) / 2 / self._rate
        self.received_seconds += dur
        await self._pending.put((now, pcm))
        self._track_transcripts(pcm, dur)

    def _track_transcripts(self, pcm: bytes, dur: float) -> None:
        words = _WORDS.get(self._target, _WORDS["en"])
        if _rms(pcm) >= self._threshold:
            self._silence_accum = 0.0
            self._speech_accum += dur
            self._in_segment = True
            if self._speech_accum >= 0.8:
                self._speech_accum = 0.0
                word = words[self._word_idx % len(words)]
                self._word_idx += 1
                self._events.put_nowait(TranscriptOut(kind="output", text=f"{word} "))
                self._events.put_nowait(
                    TranscriptOut(kind="input", text="mock ", lang="und")
                )
        else:
            self._silence_accum += dur
            if self._in_segment and self._silence_accum >= 1.2:
                self._in_segment = False
                self._events.put_nowait(SegmentEnd())

    async def _emit_loop(self) -> None:
        try:
            while True:
                item = await self._pending.get()
                if item is None:
                    return
                ts, pcm = item
                wait = ts + self._delay - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                await self._events.put(AudioOut(pcm=pcm, sample_rate=self._rate))
        except asyncio.CancelledError:
            return

    async def _timers(self) -> None:
        try:
            if self._goaway_after is not None:
                await asyncio.sleep(self._goaway_after)
                await self._events.put(GoAway(time_left_sec=1.0))
            if self._drop_after is not None:
                remaining = self._drop_after - (time.monotonic() - self._opened_at)
                if remaining > 0:
                    await asyncio.sleep(remaining)
                await self._events.put(
                    StreamError(message="mock injected drop", retryable=True)
                )
                await self._events.put(StreamClosed(reason="mock drop"))
                self._closed = True
        except asyncio.CancelledError:
            return

    async def events(self) -> AsyncIterator[ProviderEvent]:
        while True:
            ev = await self._events.get()
            yield ev
            if isinstance(ev, StreamClosed):
                return

    async def aclose(self) -> None:
        if self._closed and self._task.done():
            return
        self._closed = True
        self._pending.put_nowait(None)
        for task in (self._task, self._timer_task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._events.put_nowait(StreamClosed(reason="closed by client"))


class MockProvider(TranslationProvider):
    def __init__(
        self,
        *,
        delay_ms: int = 1200,
        sample_rate: int = 24000,
        chunk_ms: int = 50,
        allows_input_gating: bool = True,
        fail_connects: int = 0,
        drop_after_sec: float | None = None,
        goaway_after_sec: float | None = None,
        name: str = "mock",
        supported_targets: frozenset[str] = MOCK_TARGETS,
    ) -> None:
        self._delay_ms = delay_ms
        self._rate = sample_rate
        self._fail_connects = fail_connects
        self._drop_after = drop_after_sec
        self._goaway_after = goaway_after_sec
        self.connect_calls = 0
        self.streams: list[MockStream] = []
        self.capabilities = ProviderCapabilities(
            name=name,
            input_sample_rate=sample_rate,
            output_sample_rate=sample_rate,
            chunk_ms=chunk_ms,
            allows_input_gating=allows_input_gating,
            supported_targets=supported_targets,
        )

    async def connect(self, *, target_lang: str, echo_target: bool) -> ProviderStream:
        self.connect_calls += 1
        if not self.supports(target_lang):
            raise ProviderError(f"mock does not support {target_lang}", retryable=False)
        if self._fail_connects > 0:
            self._fail_connects -= 1
            raise ProviderError("mock injected connect failure")
        await asyncio.sleep(0)
        stream = MockStream(
            target_lang=target_lang,
            sample_rate=self._rate,
            delay_ms=self._delay_ms,
            drop_after_sec=self._drop_after,
            goaway_after_sec=self._goaway_after,
        )
        # Only the first stream gets injected drops/goaways so recovery can be observed.
        self._drop_after = None
        self._goaway_after = None
        self.streams.append(stream)
        return stream

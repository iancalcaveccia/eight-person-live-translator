"""One streaming translation: speaker S -> target language T within one group.

Streaming invariants (release gate):
* Input chunks are forwarded to the provider as soon as they are produced
  (100 ms for Gemini); nothing waits for an utterance, turnComplete, a
  transcript or punctuation.
* Every translated audio chunk is written to the published track the moment
  it arrives. Captions are a side channel and never delay audio.
* Overlapping speakers are independent sessions with independent tracks, so
  an interjection is never queued behind another speaker.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from audio import (
    AudioSink,
    BacklogController,
    InputChunk,
    InputGate,
    SpeakerInput,
    Subscription,
    default_resampler_factory,
)
from config import Settings
from events import RoomIO
from metering import SessionMeter, percentile
from providers.base import (
    AudioOut,
    GoAway,
    ProviderError,
    ProviderStream,
    SegmentEnd,
    StreamClosed,
    StreamError,
    TranscriptOut,
    TranslationProvider,
)

logger = logging.getLogger("translator.session")

OUTPUT_SAMPLE_RATE = 24000
HEALTHY_STREAM_SEC = 10.0


@dataclass(frozen=True)
class SessionKey:
    gathering_id: str
    group_id: str
    speaker: str
    target: str

    def short(self) -> str:
        return f"{self.speaker[:8]}->{self.target}"


def translation_track_name(speaker: str, target: str) -> str:
    return f"tx:{speaker}:{target}"


def comparison_track_name(speaker: str, target: str, provider: str) -> str:
    return f"txc:{speaker}:{target}:{provider}"


CaptionEmit = Callable[[str, dict[str, str]], None]


class CaptionPublisher:
    """Segments transcript chunks into utterances (contract §5.1).

    `emit(text, attributes)` must not block: the session queues captions and
    publishes them from a separate task so text never delays audio."""

    def __init__(
        self,
        *,
        emit: CaptionEmit,
        kind: str,
        speaker: str,
        target: str,
        gap_sec: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._emit = emit
        self.kind = kind
        self._speaker = speaker
        self._target = target
        self._gap = gap_sec
        self._clock = clock
        self.seg = 0
        self._open = False
        self._last_ts = 0.0
        self.provider = ""
        self.source_lang = ""

    def _attrs(self, final: bool) -> dict[str, str]:
        return {
            "kind": self.kind,
            "source_identity": self._speaker,
            "target_lang": self._target if self.kind == "translation" else "",
            "source_lang": self.source_lang or "",
            "final": "true" if final else "false",
            "seg": str(self.seg),
            "provider": self.provider,
        }

    def text(self, text: str) -> None:
        if not text:
            return
        self._open = True
        self._last_ts = self._clock()
        self._emit(text, self._attrs(False))

    def end_segment(self) -> None:
        if not self._open:
            return
        self._emit("", self._attrs(True))
        self._open = False
        self.seg += 1

    def tick(self) -> None:
        if self._open and self._clock() - self._last_ts >= self._gap:
            self.end_segment()


class TranslationSession:
    def __init__(
        self,
        *,
        key: SessionKey,
        speaker_input: SpeakerInput,
        providers: list[TranslationProvider],
        echo_target: bool,
        room_io: RoomIO,
        settings: Settings,
        track_name: str | None = None,
        publish_captions: bool = True,
        publish_source: bool = False,
        emit_events: bool = True,
        resampler_factory: Callable[[int, int], Any] = default_resampler_factory,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:
        if not providers:
            raise ValueError("at least one provider is required")
        self.key = key
        self._input = speaker_input
        self._providers = providers
        self._provider_idx = 0
        self._echo = echo_target
        self._io = room_io
        self._settings = settings
        self.track_name = track_name or translation_track_name(key.speaker, key.target)
        self._publish_captions = publish_captions
        self.publish_source = publish_source
        self._emit_events = emit_events
        self._resampler_factory = resampler_factory
        self._clock = clock
        self._sleep = sleep

        self.state = "idle"
        self.meters: list[SessionMeter] = []
        self.meter = self._new_meter()
        self._sink: AudioSink | None = None
        self._sid: str | None = None
        self._sub: Subscription | None = None
        self._gate: InputGate | None = None
        self._current: ProviderStream | None = None
        self._streams: set[ProviderStream] = set()
        self._stream_started: dict[int, float] = {}
        self._send_lock = asyncio.Lock()
        self._pending: deque[InputChunk] = deque()
        self._pending_ms = 0.0
        self._need_reconnect = asyncio.Event()
        self._closed = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._receivers: set[asyncio.Task] = set()
        self._rotating = False
        self._failures = 0
        self._backlog = BacklogController(
            soft_ms=settings.backlog_soft_ms,
            hard_ms=settings.backlog_hard_ms,
            keep_silence_ms=settings.silence_trim_keep_ms,
        )
        self._out_resamplers: dict[int, Any] = {}
        self._last_output_ts: float | None = None
        self._last_measured_onset: float | None = None
        self._stalls = 0
        self.connect_count = 0
        self.rotations = 0
        self.first_output_ts: float | None = None
        self._outbox: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=500)
        self._captions = CaptionPublisher(
            emit=self._queue_caption,
            kind="translation",
            speaker=key.speaker,
            target=key.target,
            gap_sec=settings.caption_segment_gap_sec,
            clock=clock,
        )
        self._source_captions = CaptionPublisher(
            emit=self._queue_caption,
            kind="source",
            speaker=key.speaker,
            target=key.target,
            gap_sec=settings.caption_segment_gap_sec,
            clock=clock,
        )

    # --- outbox (captions + events never block the audio path) ----------------

    def _queue_caption(self, text: str, attributes: dict[str, str]) -> None:
        self._enqueue(("caption", (text, attributes)))

    def _queue_event(self, payload: dict[str, Any]) -> None:
        if self._emit_events:
            self._enqueue(("event", payload))

    def _enqueue(self, item: tuple[str, Any]) -> None:
        if self._outbox.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._outbox.get_nowait()  # drop the oldest; never block audio
        self._outbox.put_nowait(item)

    async def _outbox_worker(self) -> None:
        while True:
            kind, payload = await self._outbox.get()
            try:
                if kind == "caption":
                    text, attrs = payload
                    await self._io.publish_caption(
                        text=text, sender_identity=self.key.speaker, attributes=attrs
                    )
                else:
                    await self._io.publish_event(payload)
            except Exception as exc:  # pragma: no cover - best effort
                logger.debug("outbox publish failed: %s", exc)

    async def _flush_outbox(self, timeout: float = 1.0) -> None:
        deadline = self._clock() + timeout
        while not self._outbox.empty() and self._clock() < deadline:
            kind, payload = self._outbox.get_nowait()
            with contextlib.suppress(Exception):
                if kind == "caption":
                    text, attrs = payload
                    await self._io.publish_caption(
                        text=text, sender_identity=self.key.speaker, attributes=attrs
                    )
                else:
                    await self._io.publish_event(payload)

    # --- properties ----------------------------------------------------------

    @property
    def provider(self) -> TranslationProvider:
        return self._providers[self._provider_idx]

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def _new_meter(self) -> SessionMeter:
        m = SessionMeter(
            speaker_id=self.key.speaker,
            target_lang=self.key.target,
            provider=self._providers[self._provider_idx].name,
        )
        self.meters.append(m)
        return m

    def take_usage_records(self) -> list[dict]:
        records = []
        for m in list(self.meters):
            if not m.is_empty():
                records.append(m.take_record())
            if m is not self.meter:
                self.meters.remove(m)
        return records

    def stats(self) -> dict[str, Any]:
        samples = self.meter.all_first_audio_ms
        p50 = percentile(samples, 50)
        p95 = percentile(samples, 95)
        return {
            "speaker": self.key.speaker,
            "target": self.key.target,
            "provider": self.provider.name,
            "firstAudioP50Ms": round(p50) if p50 is not None else None,
            "firstAudioP95Ms": round(p95) if p95 is not None else None,
            "backlogMs": round(self._sink.queued_ms()) if self._sink else 0,
            "stalls": self._stalls,
            "droppedMs": round(self._backlog.dropped_ms),
        }

    # --- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        self._sink = self._io.make_sink(OUTPUT_SAMPLE_RATE)
        self._sid = await self._io.publish_audio(self.track_name, self._sink)
        self._attach_input()
        self._tasks = [
            asyncio.create_task(self._run(), name=f"session/{self.key.short()}"),
            asyncio.create_task(self._sender_loop(), name=f"sender/{self.key.short()}"),
            asyncio.create_task(self._ticker(), name=f"ticker/{self.key.short()}"),
            asyncio.create_task(
                self._outbox_worker(), name=f"outbox/{self.key.short()}"
            ),
        ]
        logger.info(
            "session started %s track=%s provider=%s echo=%s",
            self.key.short(),
            self.track_name,
            self.provider.name,
            self._echo,
        )

    def _attach_input(self) -> None:
        prov = self.provider
        old = self._sub
        self._sub = self._input.subscribe(
            sample_rate=prov.input_sample_rate, chunk_ms=prov.chunk_ms
        )
        self._gate = InputGate(
            enabled=self._settings.input_gate and prov.capabilities.allows_input_gating,
            pre_roll_ms=self._settings.gate_pre_roll_ms,
            hangover_ms=self._settings.gate_hangover_ms,
            chunk_ms=prov.chunk_ms,
        )
        self._pending.clear()
        self._pending_ms = 0.0
        if old is not None:
            self._input.unsubscribe(old)

    async def aclose(self, reason: str = "stopped") -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        self._need_reconnect.set()
        tasks = [*self._tasks, *self._receivers]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()
        self._receivers.clear()
        streams = list(self._streams)
        self._streams.clear()
        self._current = None
        await asyncio.gather(*(s.aclose() for s in streams), return_exceptions=True)
        self.meter.mark_disconnected()
        if self._sub is not None:
            self._input.unsubscribe(self._sub)
        if self._publish_captions:
            self._captions.end_segment()
            if self.publish_source:
                self._source_captions.end_segment()
        if self._sid is not None:
            await self._io.unpublish(self._sid)
        if self._sink is not None:
            self._sink.clear()
            await self._sink.aclose()
        await self._set_state("stopped", reason=reason)
        await self._flush_outbox()
        logger.info("session closed %s (%s)", self.key.short(), reason)

    # --- state/events ---------------------------------------------------------

    async def _set_state(self, state: str, *, reason: str | None = None) -> None:
        if state == self.state:
            return
        if state == "delayed":
            self._stalls += 1
        self.state = state
        self._queue_event(
            {
                "t": "session",
                "speaker": self.key.speaker,
                "target": self.key.target,
                "provider": self.provider.name,
                "state": state,
                "backlogMs": round(self._sink.queued_ms()) if self._sink else 0,
                "reason": reason,
            }
        )

    # --- main loop ---------------------------------------------------------------

    async def _run(self) -> None:
        first = True
        while not self._closed.is_set():
            prov = self.provider
            await self._set_state("connecting" if first else "reconnecting")
            first = False
            try:
                stream = await prov.connect(
                    target_lang=self.key.target, echo_target=self._echo
                )
            except ProviderError as exc:
                self.meter.errors += 1
                self._failures += 1
                logger.warning(
                    "connect failed %s via %s (#%d): %s",
                    self.key.short(),
                    prov.name,
                    self._failures,
                    exc,
                )
                if await self._maybe_fallback(retryable=exc.retryable):
                    continue
                if not exc.retryable and self._provider_idx == len(self._providers) - 1:
                    await self._set_state("error", reason=str(exc)[:120])
                await self._backoff()
                continue

            self.connect_count += 1
            await self._install(stream)
            await self._set_state("live")

            await self._need_reconnect.wait()
            if self._closed.is_set():
                return
            self._need_reconnect.clear()
            failed = self._current
            self._current = None
            started = (
                self._stream_started.get(id(failed), self._clock())
                if failed
                else self._clock()
            )
            if failed is not None:
                await self._drop_stream(failed)
            self.meter.mark_disconnected()
            lived = self._clock() - started
            if lived >= HEALTHY_STREAM_SEC:
                self._failures = 0
            else:
                self._failures += 1
            if await self._maybe_fallback(retryable=True):
                continue
            await self._backoff()

    async def _backoff(self) -> None:
        schedule = self._settings.reconnect_backoff_sec
        idx = min(max(self._failures - 1, 0), len(schedule) - 1)
        delay = schedule[idx]
        if delay <= 0:
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._closed.wait(), timeout=delay)

    async def _maybe_fallback(self, *, retryable: bool) -> bool:
        threshold = self._settings.provider_failures_before_fallback
        if self._provider_idx + 1 >= len(self._providers):
            return False
        if retryable and self._failures < threshold:
            return False
        old = self.provider.name
        self._provider_idx += 1
        self._failures = 0
        self.meter.mark_disconnected()
        self.meter = self._new_meter()
        self._attach_input()
        logger.warning(
            "session %s falling back %s -> %s",
            self.key.short(),
            old,
            self.provider.name,
        )
        await self._set_state(
            "reconnecting", reason=f"fallback:{old}->{self.provider.name}"
        )
        return True

    async def _install(self, stream: ProviderStream) -> None:
        """Make `stream` current, flushing audio buffered during the outage."""
        self._streams.add(stream)
        self._stream_started[id(stream)] = self._clock()
        self.meter.mark_connected()
        async with self._send_lock:
            while self._pending:
                chunk = self._pending.popleft()
                try:
                    await stream.send_audio(chunk.pcm)
                    self.meter.input_seconds += chunk.duration_sec
                except ProviderError:
                    break
            self._pending_ms = 0.0
            self._current = stream
        task = asyncio.create_task(
            self._receive(stream), name=f"recv/{self.key.short()}"
        )
        self._receivers.add(task)
        task.add_done_callback(self._receivers.discard)

    async def _drop_stream(self, stream: ProviderStream) -> None:
        self._streams.discard(stream)
        self._stream_started.pop(id(stream), None)
        with contextlib.suppress(Exception):
            await stream.aclose()

    # --- input ---------------------------------------------------------------

    async def _sender_loop(self) -> None:
        while not self._closed.is_set():
            sub = self._sub
            if sub is None:
                await self._sleep(0.05)
                continue
            item = await sub.queue.get()
            if item is None:
                if sub is self._sub:
                    return  # speaker input ended
                continue  # subscription swapped (provider fallback)
            if sub is not self._sub:
                continue
            assert self._gate is not None
            for chunk in self._gate.process(item):
                await self._send_chunk(chunk)

    async def _send_chunk(self, chunk: InputChunk) -> None:
        async with self._send_lock:
            stream = self._current
            if stream is None:
                self._buffer_pending(chunk)
                return
            try:
                await stream.send_audio(chunk.pcm)
                self.meter.input_seconds += chunk.duration_sec
            except ProviderError as exc:
                logger.debug("send failed %s: %s", self.key.short(), exc)
                self._buffer_pending(chunk)
                if stream is self._current:
                    self._need_reconnect.set()

    def _buffer_pending(self, chunk: InputChunk) -> None:
        self._pending.append(chunk)
        self._pending_ms += chunk.duration_sec * 1000
        limit = self._settings.reconnect_replay_ms
        while self._pending and self._pending_ms > limit:
            old = self._pending.popleft()
            self._pending_ms -= old.duration_sec * 1000

    # --- output ---------------------------------------------------------------

    async def _receive(self, stream: ProviderStream) -> None:
        try:
            async for ev in stream.events():
                if self._closed.is_set():
                    return
                if isinstance(ev, AudioOut):
                    await self._on_audio(ev)
                elif isinstance(ev, TranscriptOut):
                    await self._on_transcript(ev)
                elif isinstance(ev, SegmentEnd):
                    if self._publish_captions:
                        self._captions.end_segment()
                        if self.publish_source:
                            self._source_captions.end_segment()
                elif isinstance(ev, GoAway):
                    if stream is self._current and not self._rotating:
                        task = asyncio.create_task(self._rotate(stream))
                        self._receivers.add(task)
                        task.add_done_callback(self._receivers.discard)
                elif isinstance(ev, StreamError):
                    self.meter.errors += 1
                    logger.warning("stream error %s: %s", self.key.short(), ev.message)
                    if not ev.retryable:
                        self._failures = (
                            self._settings.provider_failures_before_fallback
                        )
                elif isinstance(ev, StreamClosed):
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("receiver crashed %s", self.key.short())
        if stream is self._current and not self._closed.is_set():
            self._need_reconnect.set()
        elif stream is not self._current:
            await self._drop_stream(stream)

    async def _rotate(self, old: ProviderStream) -> None:
        """Make-before-break: open a new stream, switch input, drain the old one."""
        self._rotating = True
        try:
            try:
                new = await self.provider.connect(
                    target_lang=self.key.target, echo_target=self._echo
                )
            except ProviderError as exc:
                logger.warning("rotation connect failed %s: %s", self.key.short(), exc)
                return
            self.rotations += 1
            self.connect_count += 1
            await self._install(new)
            logger.info("rotated provider stream %s", self.key.short())
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._closed.wait(), timeout=self._settings.rotation_drain_sec
                )
            if old in self._streams:
                await self._drop_stream(old)
        finally:
            self._rotating = False

    async def _on_audio(self, ev: AudioOut) -> None:
        assert self._sink is not None
        now = self._clock()
        pcm = ev.pcm
        if ev.sample_rate != OUTPUT_SAMPLE_RATE:
            rs = self._out_resamplers.get(ev.sample_rate)
            if rs is None:
                rs = self._resampler_factory(ev.sample_rate, OUTPUT_SAMPLE_RATE)
                self._out_resamplers[ev.sample_rate] = rs
            pcm = rs.push(pcm)
        self.meter.output_seconds += ev.duration_sec
        if not self._backlog.is_silent(pcm):
            # Latency and liveness are measured on AUDIBLE output only.
            self._measure_first_audio(now)
            self._last_output_ts = now
            if self.first_output_ts is None:
                self.first_output_ts = now
        out = self._backlog.process(
            pcm, sample_rate=OUTPUT_SAMPLE_RATE, queued_ms=self._sink.queued_ms()
        )
        if out:
            await self._sink.write(out)
        backlog = self._sink.queued_ms()
        if backlog >= self._settings.backlog_soft_ms:
            await self._set_state("delayed", reason="backlog")
        elif self.state == "delayed":
            await self._set_state("live")

    def _measure_first_audio(self, now: float) -> None:
        onset = self._input.last_onset_ts
        if onset is None or onset == self._last_measured_onset:
            return
        self._last_measured_onset = onset
        idle_before = (
            self._last_output_ts is None or onset - self._last_output_ts >= 1.0
        )
        if not idle_before or now < onset:
            return  # previous translation still playing; latency not measurable
        latency_ms = (now - onset) * 1000.0
        self.meter.add_first_audio(latency_ms)
        self._queue_event(
            {
                "t": "first_audio",
                "speaker": self.key.speaker,
                "target": self.key.target,
                "provider": self.provider.name,
                "latencyMs": round(latency_ms),
            }
        )

    async def _on_transcript(self, ev: TranscriptOut) -> None:
        if not self._publish_captions:
            return
        provider = self.provider.name
        self._captions.provider = provider
        self._source_captions.provider = provider
        if ev.kind == "input":
            if ev.lang:
                self._captions.source_lang = ev.lang
                self._source_captions.source_lang = ev.lang
            if self.publish_source:
                self._source_captions.text(ev.text)
        else:
            self._captions.text(ev.text)

    async def _ticker(self) -> None:
        """1 Hz housekeeping: caption segmentation and 'delayed' detection."""
        while not self._closed.is_set():
            await self._sleep(1.0)
            if self._publish_captions:
                self._captions.tick()
                if self.publish_source:
                    self._source_captions.tick()
            if self.state not in ("live", "delayed"):
                continue
            now = self._clock()
            onset = self._input.last_onset_ts
            speaking = self._input.speech_active
            waiting_since = max(
                x for x in (onset, self._last_output_ts, 0.0) if x is not None
            )
            if (
                speaking
                and onset is not None
                and now - waiting_since > self._settings.delayed_no_output_sec
            ):
                await self._set_state("delayed", reason="no_output")

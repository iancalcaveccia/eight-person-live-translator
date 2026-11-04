"""Audio plumbing: per-speaker input fan-out, silence gate, bleed guard and
output backlog control.

Design
------
* One `SpeakerInput` per human microphone reads the LiveKit track ONCE at
  48 kHz (10 ms frames) and fans frames out to every translation session of
  that speaker. Each distinct provider sample rate gets one resampler per
  speaker, and each session gets its own chunker (e.g. 100 ms for Gemini).
* `EnergyVad` (adaptive minimum-statistics floor) marks frames as speech.
  It fails OPEN: until it has a floor estimate, any non-silent frame counts as
  speech.
* `BleedGuard` compares energy envelopes of speakers in the same room. A
  frame on speaker B is flagged as *bleed* only when B's envelope is strongly
  correlated with a clearly louder speaker A (another person's voice leaking
  into B's mic). An independent interjection by B is never flagged because
  its envelope does not track A's and its level is comparable to A's.
* `InputGate` (per session) withholds audio during silence for providers that
  allow it (Gemini) to avoid paying for silent input, with pre-roll (so speech
  onsets are never clipped) and a generous hangover (so the provider can
  finish translating). It never waits for an utterance to end.
* `BacklogController` keeps translated output from accumulating unbounded
  delay: above a soft limit it trims long silences; above a hard limit it
  drops audio and reports how much.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from config import AUDIO_CHANNELS, INPUT_CAPTURE_SAMPLE_RATE, INPUT_FRAME_MS, Settings

logger = logging.getLogger("translator.audio")

SILENCE_DBFS = -90.0


def energy_dbfs(samples: np.ndarray) -> float:
    """RMS level of int16 samples in dBFS."""
    if samples.size == 0:
        return SILENCE_DBFS
    x = samples.astype(np.float32)
    rms = float(np.sqrt(np.mean(x * x)))
    if rms <= 0.0:
        return SILENCE_DBFS
    return max(SILENCE_DBFS, 20.0 * math.log10(rms / 32768.0))


# --- VAD ----------------------------------------------------------------------


class EnergyVad:
    """Adaptive energy VAD using a minimum-statistics noise floor.

    The floor is the minimum frame energy over the last `floor_window_ms`,
    tracked in 100 ms buckets. Speech = energy above floor + threshold and above
    an absolute minimum. Before any floor exists the VAD fails open.
    """

    def __init__(
        self,
        *,
        threshold_db: float = 9.0,
        min_dbfs: float = -55.0,
        floor_window_ms: int = 3000,
        frame_ms: int = INPUT_FRAME_MS,
    ) -> None:
        self._threshold = threshold_db
        self._min_dbfs = min_dbfs
        self._frames_per_bucket = max(1, 100 // frame_ms)
        self._buckets: deque[float] = deque(maxlen=max(1, floor_window_ms // 100))
        self._bucket_min = math.inf
        self._bucket_count = 0

    @property
    def floor_db(self) -> float | None:
        if not self._buckets:
            return None
        return min(self._buckets)

    def update(self, level_db: float) -> bool:
        self._bucket_min = min(self._bucket_min, level_db)
        self._bucket_count += 1
        if self._bucket_count >= self._frames_per_bucket:
            self._buckets.append(self._bucket_min)
            self._bucket_min = math.inf
            self._bucket_count = 0

        if level_db < self._min_dbfs:
            return False
        floor = self.floor_db
        if floor is None or len(self._buckets) < 3:
            return True  # fail open until the floor estimate is meaningful
        return level_db >= floor + self._threshold


# --- Bleed guard ---------------------------------------------------------------


class BleedGuard:
    """Detects another person's voice leaking into a speaker's microphone.

    Energy samples are binned by arrival time (10 ms bins). For speaker B the
    guard looks for another speaker A such that, over the analysis window,
      * A is active and its median level exceeds B's by >= level_diff_db, and
      * the maximum Pearson correlation of the two envelopes over lags within
        +/- max_lag_ms is >= corr_threshold.
    Both conditions must hold, which keeps independent (even quiet)
    interjections from being suppressed.
    """

    BIN_MS = 10

    def __init__(
        self,
        *,
        enabled: bool = True,
        corr_threshold: float = 0.9,
        level_diff_db: float = 13.0,
        window_ms: int = 1000,
        max_lag_ms: int = 120,
        persist_evals: int = 3,
        active_dbfs: float = -50.0,
        floor_dbfs: float = -60.0,
        eval_every_bins: int = 5,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.enabled = enabled
        self._corr = corr_threshold
        self._diff = level_diff_db
        self._win = max(10, window_ms // self.BIN_MS)
        self._lag = max(0, max_lag_ms // self.BIN_MS)
        self._persist = max(1, persist_evals)
        self._active = active_dbfs
        self._floor = floor_dbfs
        self._eval_every = eval_every_bins
        self._clock = clock
        self._history = self._win + 2 * self._lag + 20
        self._env: dict[str, dict[int, float]] = {}
        self._last_eval_bin: dict[str, int] = {}
        self._cached: dict[str, bool] = {}
        self._hits: dict[str, int] = {}
        self.flag_count: dict[str, int] = {}

    def remove(self, speaker: str) -> None:
        self._env.pop(speaker, None)
        self._last_eval_bin.pop(speaker, None)
        self._cached.pop(speaker, None)
        self._hits.pop(speaker, None)

    def update(self, speaker: str, level_db: float, ts: float | None = None) -> None:
        if not self.enabled:
            return
        b = int((self._clock() if ts is None else ts) * 1000 // self.BIN_MS)
        env = self._env.setdefault(speaker, {})
        env[b] = max(level_db, env.get(b, SILENCE_DBFS))
        if len(env) > self._history * 2:
            cutoff = b - self._history
            for k in [k for k in env if k < cutoff]:
                del env[k]

    def _series(self, speaker: str, start_bin: int, length: int) -> np.ndarray:
        env = self._env.get(speaker, {})
        return np.array(
            [env.get(start_bin + i, SILENCE_DBFS) for i in range(length)],
            dtype=np.float32,
        )

    def is_bleed(self, speaker: str, ts: float | None = None) -> bool:
        if not self.enabled or len(self._env) < 2:
            return False
        now_bin = int((self._clock() if ts is None else ts) * 1000 // self.BIN_MS)
        last = self._last_eval_bin.get(speaker)
        if last is not None and now_bin - last < self._eval_every:
            return self._cached.get(speaker, False)
        self._last_eval_bin[speaker] = now_bin
        hit = self._evaluate(speaker, now_bin)
        hits = self._hits.get(speaker, 0) + 1 if hit else 0
        self._hits[speaker] = hits
        result = hits >= self._persist  # require persistence before suppressing
        self._cached[speaker] = result
        if result:
            self.flag_count[speaker] = self.flag_count.get(speaker, 0) + 1
        return result

    def _evaluate(self, speaker: str, now_bin: int) -> bool:
        # Leave a margin for frames of other speakers that have not arrived yet.
        end = now_bin - self._lag
        start = end - self._win
        b = self._series(speaker, start, self._win)
        b_active = b[b > self._active]
        if b_active.size < self._win * 0.3:
            return False
        b_level = float(np.median(b_active))
        b_std = float(np.std(b))
        if b_std < 1e-3:
            return False
        for other in self._env:
            if other == speaker:
                continue
            a_ext = self._series(other, start - self._lag, self._win + 2 * self._lag)
            a_core = a_ext[self._lag : self._lag + self._win]
            a_active = a_core[a_core > self._active]
            if a_active.size < self._win * 0.3:
                continue
            if float(np.median(a_active)) - b_level < self._diff:
                continue
            windows = np.lib.stride_tricks.sliding_window_view(
                np.maximum(a_ext, self._floor), self._win
            )
            corr = _max_corr(np.maximum(b, self._floor), windows)
            if corr >= self._corr:
                return True
        return False


def _max_corr(b: np.ndarray, windows: np.ndarray) -> float:
    bc = b - b.mean()
    bn = float(np.sqrt(np.sum(bc * bc)))
    if bn < 1e-6:
        return 0.0
    wc = windows - windows.mean(axis=1, keepdims=True)
    wn = np.sqrt(np.sum(wc * wc, axis=1))
    with np.errstate(divide="ignore", invalid="ignore"):
        c = (wc @ bc) / (wn * bn)
    c = np.nan_to_num(c, nan=0.0, posinf=0.0, neginf=0.0)
    return float(c.max()) if c.size else 0.0


# --- Chunks, gate --------------------------------------------------------------


@dataclass(frozen=True)
class InputChunk:
    pcm: bytes
    sample_rate: int
    speech: bool  # any frame in the chunk was speech (after bleed suppression)
    bleed: bool  # every speech-like frame in the chunk was flagged as bleed
    ts: float  # monotonic time of the first frame

    @property
    def duration_sec(self) -> float:
        return len(self.pcm) / 2 / self.sample_rate


class InputGate:
    """Per-session silence gate with pre-roll and hangover.

    `process(chunk)` returns the chunks to send right now. When disabled (or
    for providers that need continuous audio, e.g. OpenAI) every chunk passes
    unchanged — including chunks flagged as bleed, because with no pre-roll to
    recover from a false flag, suppressing them could erase real speech.
    When enabled, bleed-flagged chunks only keep the gate from OPENING; they
    sit in the pre-roll buffer and are sent if real speech follows.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        pre_roll_ms: int,
        hangover_ms: int,
        chunk_ms: int,
    ) -> None:
        self.enabled = enabled
        self._hangover = hangover_ms / 1000.0
        self._pre_roll: deque[InputChunk] = deque(
            maxlen=max(1, math.ceil(pre_roll_ms / chunk_ms))
        )
        self._open = not enabled
        self._last_speech_ts: float | None = None
        self.opened_count = 0

    @property
    def is_open(self) -> bool:
        return self._open

    def process(self, chunk: InputChunk) -> list[InputChunk]:
        if not self.enabled:
            return [chunk]

        if chunk.speech:
            self._last_speech_ts = chunk.ts
            if not self._open:
                self._open = True
                self.opened_count += 1
                out = [*self._pre_roll, chunk]
                self._pre_roll.clear()
                return out
            return [chunk]

        if self._open:
            if (
                self._last_speech_ts is not None
                and chunk.ts - self._last_speech_ts > self._hangover
            ):
                self._open = False
                self._pre_roll.append(chunk)
                return []
            return [chunk]

        self._pre_roll.append(chunk)
        return []


class Subscription:
    """A session's view of a SpeakerInput: fixed-size chunks at one rate."""

    def __init__(
        self, *, sample_rate: int, chunk_ms: int, max_queue: int = 100
    ) -> None:
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms
        self._chunk_bytes = int(sample_rate * chunk_ms / 1000) * 2
        self._buf = bytearray()
        self._speech = False
        self._all_bleed = True
        self._any_flag = False
        self._ts: float | None = None
        self.queue: asyncio.Queue[InputChunk | None] = asyncio.Queue(maxsize=max_queue)
        self.dropped_chunks = 0
        self.closed = False

    def feed(self, pcm: bytes, *, speech: bool, bleed: bool, ts: float) -> None:
        if self.closed:
            return
        if self._ts is None:
            self._ts = ts
        self._buf.extend(pcm)
        self._speech = self._speech or speech
        if speech or bleed:
            self._any_flag = True
            self._all_bleed = self._all_bleed and bleed and not speech
        while len(self._buf) >= self._chunk_bytes:
            out = bytes(self._buf[: self._chunk_bytes])
            del self._buf[: self._chunk_bytes]
            chunk = InputChunk(
                pcm=out,
                sample_rate=self.sample_rate,
                speech=self._speech,
                bleed=self._any_flag and self._all_bleed,
                ts=self._ts if self._ts is not None else ts,
            )
            self._push(chunk)
            self._speech = False
            self._all_bleed = True
            self._any_flag = False
            self._ts = ts

    def _push(self, chunk: InputChunk) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
            self.dropped_chunks += 1
        self.queue.put_nowait(chunk)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        self.queue.put_nowait(None)

    async def __aiter__(
        self,
    ) -> AsyncIterator[InputChunk]:  # pragma: no cover - trivial
        while True:
            item = await self.queue.get()
            if item is None:
                return
            yield item


class Resampler(Protocol):
    def push(self, pcm: bytes) -> bytes: ...


class _RtcResampler:
    def __init__(self, in_rate: int, out_rate: int) -> None:
        from livekit import rtc

        self._r = rtc.AudioResampler(
            in_rate,
            out_rate,
            num_channels=AUDIO_CHANNELS,
            quality=rtc.AudioResamplerQuality.MEDIUM,
        )

    def push(self, pcm: bytes) -> bytes:
        frames = self._r.push(bytearray(pcm))
        return b"".join(bytes(f.data.cast("b")) for f in frames)


class _DecimatingResampler:
    """Dependency-free fallback (integer ratios only) used in tests."""

    def __init__(self, in_rate: int, out_rate: int) -> None:
        if in_rate % out_rate:
            raise ValueError("only integer decimation supported")
        self._step = in_rate // out_rate

    def push(self, pcm: bytes) -> bytes:
        x = np.frombuffer(pcm, dtype=np.int16)
        if self._step == 1:
            return pcm
        n = (x.size // self._step) * self._step
        y = x[:n].reshape(-1, self._step).mean(axis=1).astype(np.int16)
        return y.tobytes()


def default_resampler_factory(in_rate: int, out_rate: int) -> Resampler:
    return _RtcResampler(in_rate, out_rate)


def simple_resampler_factory(in_rate: int, out_rate: int) -> Resampler:
    return _DecimatingResampler(in_rate, out_rate)


OnsetCallback = Callable[[str, float], None]


class SpeakerInput:
    """Reads one speaker's mic once and fans it out to sessions."""

    def __init__(
        self,
        *,
        identity: str,
        frames: AsyncIterator[bytes],
        settings: Settings,
        bleed_guard: BleedGuard | None = None,
        on_onset: OnsetCallback | None = None,
        resampler_factory: Callable[[int, int], Resampler] = default_resampler_factory,
        capture_rate: int = INPUT_CAPTURE_SAMPLE_RATE,
        clock: Callable[[], float] = time.monotonic,
        onset_silence_ms: int = 600,
    ) -> None:
        self.identity = identity
        self._frames = frames
        self._settings = settings
        self._guard = bleed_guard
        self._on_onset = on_onset
        self._resampler_factory = resampler_factory
        self._capture_rate = capture_rate
        self._clock = clock
        self._vad = EnergyVad(
            threshold_db=settings.vad_threshold_db, min_dbfs=settings.vad_min_dbfs
        )
        self._subs: dict[int, list[Subscription]] = {}
        self._resamplers: dict[int, Resampler] = {}
        self._task: asyncio.Task | None = None
        self._silence_run_ms = float(onset_silence_ms)
        self._onset_silence_ms = onset_silence_ms
        self.last_onset_ts: float | None = None
        self.speech_active = False
        self.frames_read = 0
        self.bleed_frames = 0

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name=f"speaker-input/{self.identity}"
            )

    def subscribe(self, *, sample_rate: int, chunk_ms: int) -> Subscription:
        sub = Subscription(sample_rate=sample_rate, chunk_ms=chunk_ms)
        self._subs.setdefault(sample_rate, []).append(sub)
        if sample_rate != self._capture_rate and sample_rate not in self._resamplers:
            self._resamplers[sample_rate] = self._resampler_factory(
                self._capture_rate, sample_rate
            )
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        subs = self._subs.get(sub.sample_rate, [])
        if sub in subs:
            subs.remove(sub)
        sub.close()

    @property
    def subscriber_count(self) -> int:
        return sum(len(v) for v in self._subs.values())

    async def _run(self) -> None:
        try:
            async for pcm in self._frames:
                self.process_frame(pcm)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("speaker input %s failed", self.identity)
        finally:
            for subs in self._subs.values():
                for sub in subs:
                    sub.close()

    def process_frame(self, pcm: bytes, ts: float | None = None) -> None:
        """Process one 10 ms capture frame (public for tests)."""
        now = self._clock() if ts is None else ts
        self.frames_read += 1
        samples = np.frombuffer(pcm, dtype=np.int16)
        level = energy_dbfs(samples)
        try:
            vad_speech = self._vad.update(level)
        except Exception:  # fail open
            vad_speech = True
        bleed = False
        if self._guard is not None and self._guard.enabled:
            self._guard.update(self.identity, level, now)
            if vad_speech:
                try:
                    bleed = self._guard.is_bleed(self.identity, now)
                except Exception:
                    bleed = False
        speech = vad_speech and not bleed
        if bleed:
            self.bleed_frames += 1

        frame_ms = samples.size * 1000.0 / self._capture_rate
        if speech:
            if self._silence_run_ms >= self._onset_silence_ms:
                self.last_onset_ts = now
                if self._on_onset is not None:
                    with contextlib.suppress(Exception):
                        self._on_onset(self.identity, now)
            self._silence_run_ms = 0.0
            self.speech_active = True
        else:
            self._silence_run_ms += frame_ms
            if self._silence_run_ms >= self._onset_silence_ms:
                self.speech_active = False

        for rate, subs in self._subs.items():
            if not subs:
                continue
            if rate == self._capture_rate:
                data = pcm
            else:
                data = self._resamplers[rate].push(pcm)
            if not data:
                continue
            for sub in list(subs):
                sub.feed(data, speech=speech, bleed=bleed, ts=now)

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        for subs in self._subs.values():
            for sub in subs:
                sub.close()
        self._subs.clear()
        if self._guard is not None:
            self._guard.remove(self.identity)
        aclose = getattr(self._frames, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()


async def livekit_track_frames(
    track: Any, *, sample_rate: int = INPUT_CAPTURE_SAMPLE_RATE
) -> AsyncIterator[bytes]:
    """Yield 10 ms PCM16 mono frames from a LiveKit remote audio track."""
    from livekit import rtc

    stream = rtc.AudioStream.from_track(
        track=track,
        sample_rate=sample_rate,
        num_channels=AUDIO_CHANNELS,
        frame_size_ms=INPUT_FRAME_MS,
    )
    try:
        async for ev in stream:
            yield bytes(ev.frame.data.cast("b"))
    finally:
        with contextlib.suppress(Exception):
            await stream.aclose()


# --- Output --------------------------------------------------------------------


class BacklogController:
    """Bounds translated-audio delay. Pure logic, unit tested."""

    def __init__(
        self,
        *,
        soft_ms: int,
        hard_ms: int,
        keep_silence_ms: int,
        silence_dbfs: float = -45.0,
        window_ms: int = 10,
    ) -> None:
        self.soft_ms = soft_ms
        self.hard_ms = hard_ms
        self._keep = keep_silence_ms
        self._silence = silence_dbfs
        self._win = window_ms
        self.trimmed_ms = 0.0
        self.dropped_ms = 0.0
        self.idle_silence_ms = 0.0

    def is_silent(self, pcm: bytes) -> bool:
        x = np.frombuffer(pcm, dtype=np.int16)
        if x.size == 0:
            return True
        return (
            energy_dbfs(x) < self._silence
            and float(np.max(np.abs(x))) < 32768 * 10 ** (self._silence / 20) * 4
        )

    def process(self, pcm: bytes, *, sample_rate: int, queued_ms: float) -> bytes:
        dur_ms = len(pcm) / 2 / sample_rate * 1000.0
        if queued_ms >= self.hard_ms:
            self.dropped_ms += dur_ms
            return b""
        if queued_ms < 50 and self.is_silent(pcm):
            # Nothing is playing and this chunk is pure silence (e.g. a burst
            # of leading silence): playing it would only push the next words
            # later. Real-time pauses are unaffected because the next speech
            # chunk arrives at the same wall-clock time either way.
            self.idle_silence_ms += dur_ms
            return b""
        if queued_ms >= self.soft_ms:
            out = self._trim_silence(pcm, sample_rate)
            self.trimmed_ms += dur_ms - len(out) / 2 / sample_rate * 1000.0
            return out
        return pcm

    def _trim_silence(self, pcm: bytes, sample_rate: int) -> bytes:
        x = np.frombuffer(pcm, dtype=np.int16)
        win = max(1, int(sample_rate * self._win / 1000))
        keep_windows = max(1, self._keep // self._win)
        n_win = x.size // win
        if n_win == 0:
            return pcm
        frames = x[: n_win * win].reshape(n_win, win).astype(np.float32)
        rms = np.sqrt(np.mean(frames * frames, axis=1))
        with np.errstate(divide="ignore"):
            db = 20.0 * np.log10(np.maximum(rms, 1e-9) / 32768.0)
        silent = db < self._silence
        out: list[np.ndarray] = []
        run = 0
        for i in range(n_win):
            if silent[i]:
                run += 1
                if run > keep_windows:
                    continue
            else:
                run = 0
            out.append(x[i * win : (i + 1) * win])
        tail = x[n_win * win :]
        if tail.size:
            out.append(tail)
        return np.concatenate(out).tobytes() if out else b""


class AudioSink(Protocol):
    sample_rate: int

    def queued_ms(self) -> float: ...

    async def write(self, pcm: bytes) -> None: ...

    def clear(self) -> None: ...

    async def aclose(self) -> None: ...


class LiveKitAudioSink:
    """Writes PCM into an rtc.AudioSource with a large queue so the provider
    reader never blocks; delay is bounded by BacklogController instead."""

    def __init__(self, sample_rate: int, queue_ms: int) -> None:
        from livekit import rtc

        self.sample_rate = sample_rate
        self.source = rtc.AudioSource(
            sample_rate, AUDIO_CHANNELS, queue_size_ms=queue_ms
        )

    def queued_ms(self) -> float:
        return self.source.queued_duration * 1000.0

    async def write(self, pcm: bytes) -> None:
        from livekit import rtc

        if not pcm:
            return
        n = len(pcm) // 2
        frame = rtc.AudioFrame(
            data=pcm[: n * 2],
            sample_rate=self.sample_rate,
            num_channels=AUDIO_CHANNELS,
            samples_per_channel=n,
        )
        try:
            await self.source.capture_frame(frame)
        except Exception as exc:
            text = str(exc).lower()
            if "closed" in text or "invalidstate" in text:
                logger.debug("AudioSource closed mid-capture; dropping frame")
            else:
                raise

    def clear(self) -> None:
        with contextlib.suppress(Exception):
            self.source.clear_queue()

    async def aclose(self) -> None:
        with contextlib.suppress(Exception):
            await self.source.aclose()


class FakeAudioSink:
    """Real-time paced in-memory sink for tests."""

    def __init__(
        self, sample_rate: int, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.sample_rate = sample_rate
        self._clock = clock
        self._play_until = 0.0
        self.written: list[tuple[float, bytes]] = []
        self.closed = False

    def queued_ms(self) -> float:
        return max(0.0, self._play_until - self._clock()) * 1000.0

    async def write(self, pcm: bytes) -> None:
        now = self._clock()
        dur = len(pcm) / 2 / self.sample_rate
        self._play_until = max(self._play_until, now) + dur
        self.written.append((now, pcm))

    def clear(self) -> None:
        self._play_until = 0.0

    async def aclose(self) -> None:
        self.closed = True

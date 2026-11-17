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
    interjections from being suppressed. Because room reverb smears the leaked
    envelope, a lower correlation (`corr_relaxed`) also counts when B stays at
    least `bound_margin_db` below A's recent peak in `bounded_ratio` of its
    active bins (a leak never approaches its source's level; B's own voice
    does).

    The decision is sticky: once B is flagged against A it stays flagged until
    `release_evals` consecutive evaluations miss, so a short dip in correlation
    cannot let a leak through (the input gate's hangover would otherwise keep
    forwarding it for seconds). A frame is never flagged when B is nearly as
    loud as A's own microphone (within `own_voice_margin_db`): a leak is always
    much quieter than its source, so that is B's own voice, e.g. an
    interjection over A.

    Two phones deliver their streams with different delays (Bluetooth
    headsets, capture pipelines, jitter buffers), often far more than
    `max_lag_ms` (first real two-phone test, 2026-11-17: a neighbour's voice
    got through; offline, a 200 ms offset let ~90 % of a leak through). So
    each pair of streams is aligned first: confident matches (the strict rule)
    are searched within +/- `max_offset_ms`, and once three agree, that pair is
    compared around the measured offset with the +/- `max_lag_ms` tolerance.
    """

    BIN_MS = 10
    ALIGN_VOTES = 5  # recent confident matches kept per pair
    ALIGN_AGREE = 3  # how many must agree (within ALIGN_TOL bins) to lock
    ALIGN_TOL = 2
    VOTE_ACTIVE = 0.15  # min active share of a window to measure alignment

    def __init__(
        self,
        *,
        enabled: bool = True,
        corr_threshold: float = 0.9,
        level_diff_db: float = 13.0,
        window_ms: int = 1000,
        max_lag_ms: int = 120,
        max_offset_ms: int = 600,
        align_corr: float = 0.85,
        align_vote_spacing_ms: int = 600,
        persist_evals: int = 3,
        active_dbfs: float = -50.0,
        floor_dbfs: float = -60.0,
        eval_every_bins: int = 5,
        corr_relaxed: float = 0.7,
        bounded_ratio: float = 0.95,
        bound_margin_db: float = 14.0,
        release_evals: int = 6,
        own_voice_margin_db: float = 10.0,
        own_voice_rise_db: float = 10.0,
        own_voice_hold_ms: int = 1500,
        own_voice_persist_ms: int = 80,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.enabled = enabled
        self._corr = corr_threshold
        self._diff = level_diff_db
        self._win = max(10, window_ms // self.BIN_MS)
        self._lag = max(0, max_lag_ms // self.BIN_MS)
        self._off = max(self._lag, max_offset_ms // self.BIN_MS)
        self._align_corr = align_corr
        self._vote_spacing = max(0, align_vote_spacing_ms // self.BIN_MS)
        self._last_vote_bin: dict[tuple[str, str], int] = {}
        self._persist = max(1, persist_evals)
        self._active = active_dbfs
        self._floor = floor_dbfs
        self._eval_every = eval_every_bins
        self._corr_relaxed = corr_relaxed
        self._bounded_ratio = bounded_ratio
        self._bound_margin = bound_margin_db
        self._release = max(1, release_evals)
        self._own_margin = own_voice_margin_db
        self._clock = clock
        self._history = self._win + 2 * (self._off + self._lag) + 40
        # Unordered pair (x, y), x < y -> v: the same sound is at y-bin
        # x-bin + v (y's stream arrives v bins later than x's).
        self._pair_offset: dict[tuple[str, str], int] = {}
        self._pair_votes: dict[tuple[str, str], deque[int]] = {}
        self._env: dict[str, dict[int, float]] = {}
        self._last_eval_bin: dict[str, int] = {}
        self._cached: dict[str, bool] = {}
        self._hits: dict[str, int] = {}
        self._misses: dict[str, int] = {}
        self._source: dict[str, str] = {}  # speaker -> whose voice leaks into it
        self._seq: dict[str, tuple[int, int]] = {}  # speaker -> (anchor bin, frames)
        self._last_bin: dict[str, int] = {}
        self._resync_bins = max(20, 2 * self._lag + 10)
        self._leak_level: dict[str, float] = {}  # B's median level while leaking
        self._last_b_level = active_dbfs
        self._own_rise = own_voice_rise_db
        self._own_hold = max(0, own_voice_hold_ms // self.BIN_MS)
        self._own_until: dict[str, int] = {}
        self._own_run: dict[str, int] = {}
        self._own_persist = max(1, own_voice_persist_ms // self.BIN_MS)
        self.flag_count: dict[str, int] = {}

    def remove(self, speaker: str) -> None:
        flagged = self.flag_count.pop(speaker, 0)
        if self.enabled and speaker in self._env:
            logger.info(
                "bleed guard %s: %.1fs flagged as another person's voice",
                speaker[:8],
                flagged * self.BIN_MS / 1000,
            )
        for pair in [p for p in self._pair_offset if speaker in p]:
            self._pair_offset.pop(pair, None)
        for pair in [p for p in self._pair_votes if speaker in p]:
            self._pair_votes.pop(pair, None)
            self._last_vote_bin.pop(pair, None)
        self._env.pop(speaker, None)
        self._last_eval_bin.pop(speaker, None)
        self._cached.pop(speaker, None)
        self._hits.pop(speaker, None)
        self._misses.pop(speaker, None)
        self._source.pop(speaker, None)
        self._seq.pop(speaker, None)
        self._last_bin.pop(speaker, None)
        self._leak_level.pop(speaker, None)
        self._own_until.pop(speaker, None)
        self._own_run.pop(speaker, None)
        for k in [k for k, v in self._source.items() if v == speaker]:
            self._source.pop(k, None)
            self._cached[k] = False

    def update(self, speaker: str, level_db: float, ts: float | None = None) -> None:
        if not self.enabled:
            return
        # Bin by position in the speaker's stream (one 10 ms frame = one bin),
        # anchored to arrival time. Binning by raw arrival time leaves holes
        # and doubles whenever frames arrive in bursts (network jitter, float
        # rounding); holes read as silence and destroy the envelope
        # correlation. Re-anchor only after a real stall or skip.
        arrival = round((self._clock() if ts is None else ts) * 1000 / self.BIN_MS)
        anchor, count = self._seq.get(speaker, (arrival, 0))
        b = anchor + count
        if abs(b - arrival) > self._resync_bins:
            anchor, count, b = arrival, 0, arrival
        self._seq[speaker] = (anchor, count + 1)
        self._last_bin[speaker] = b
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
        now_bin = self._last_bin.get(speaker)
        if now_bin is None:
            now_bin = round((self._clock() if ts is None else ts) * 1000 / self.BIN_MS)
        last = self._last_eval_bin.get(speaker)
        if last is None or now_bin - last >= self._eval_every:
            self._last_eval_bin[speaker] = now_bin
            self._decide(speaker, now_bin)
        if self._own_until.get(speaker, -1) >= now_bin:
            return False  # B is talking: don't flap on its softer syllables
        if not self._cached.get(speaker, False):
            return False
        if self._sounds_like_own_voice(speaker, now_bin):
            run = self._own_run.get(speaker, 0) + 1
            self._own_run[speaker] = run
            if run >= self._own_persist:
                # B's own voice over A, confirmed for longer than any network
                # skew: hold the flag off so the whole interjection gets
                # through, and start the leak decision afresh.
                self._own_until[speaker] = now_bin + self._own_hold
                self._cached[speaker] = False
                self._hits[speaker] = 0
                self._misses[speaker] = 0
                self._own_run[speaker] = 0
                return False
        else:
            # One softer frame pauses the count instead of resetting it.
            self._own_run[speaker] = max(0, self._own_run.get(speaker, 0) - 1)
        self.flag_count[speaker] = self.flag_count.get(speaker, 0) + 1
        return True

    def _decide(self, speaker: str, now_bin: int) -> None:
        source = self._evaluate(speaker, now_bin)
        if source is not None:
            self._leak_level[speaker] = self._last_b_level
            self._misses[speaker] = 0
            hits = self._hits.get(speaker, 0) + 1
            self._hits[speaker] = hits
            if hits >= self._persist:  # require persistence before suppressing
                self._cached[speaker] = True
                self._source[speaker] = source
            return
        self._hits[speaker] = 0
        if self._cached.get(speaker, False):
            if self._still_dominated(speaker, now_bin):
                return  # the source is still far louder: not a reason to release
            misses = self._misses.get(speaker, 0) + 1
            self._misses[speaker] = misses
            if misses >= self._release:  # sticky: release only after a clear stop
                self._cached[speaker] = False
                self._misses[speaker] = 0
                self._source.pop(speaker, None)

    def _recent_peak(self, speaker: str, now_bin: int) -> float:
        env = self._env.get(speaker, {})
        return max(
            (env.get(now_bin - i, SILENCE_DBFS) for i in range(0, 2 * self._lag + 1)),
            default=SILENCE_DBFS,
        )

    # --- stream alignment ------------------------------------------------------

    def _center(self, victim: str, source: str) -> int:
        """c such that `source`'s frame for the sound at `victim`-bin t is at
        source-bin t + c (0 until the pair is aligned)."""
        x, y = (victim, source) if victim < source else (source, victim)
        v = self._pair_offset.get((x, y), 0)
        return v if x == victim else -v

    def _vote(self, victim: str, source: str, c: int, now_bin: int) -> None:
        x, y = (victim, source) if victim < source else (source, victim)
        # Successive evaluations overlap almost entirely; space the votes so
        # agreement means separate stretches of speech, not one chance match.
        last = self._last_vote_bin.get((x, y))
        if last is not None and 0 <= now_bin - last < self._vote_spacing:
            return
        self._last_vote_bin[(x, y)] = now_bin
        v = c if x == victim else -c
        votes = self._pair_votes.setdefault((x, y), deque(maxlen=self.ALIGN_VOTES))
        votes.append(v)
        if len(votes) < self.ALIGN_AGREE:
            return
        med = float(np.median(votes))
        close = [u for u in votes if abs(u - med) <= self.ALIGN_TOL]
        if len(close) < self.ALIGN_AGREE:
            return
        new = round(float(np.median(close)))
        old = self._pair_offset.get((x, y))
        if old is not None and abs(new - old) <= 1:
            return  # keep it stable against +/-1 bin jitter
        self._pair_offset[(x, y)] = new
        logger.info(
            "bleed alignment %s<->%s: %+d ms",
            x[:8],
            y[:8],
            new * self.BIN_MS,
        )

    def source_of(self, speaker: str) -> str | None:
        """Whose voice `speaker`'s mic was last flagged as carrying."""
        return self._source.get(speaker)

    def offset_ms(self, victim: str, source: str) -> int | None:
        """Measured stream offset for a pair (None until aligned); for logs/tests."""
        x, y = (victim, source) if victim < source else (source, victim)
        if (x, y) not in self._pair_offset:
            return None
        return self._center(victim, source) * self.BIN_MS

    def _aligned_recent(self, source: str, speaker: str, now_bin: int) -> list[float]:
        """`source`'s last 2*lag+1 frames aligned to `speaker`'s now_bin, using
        only frames that have already arrived."""
        c = self._center(speaker, source)
        hi = min(now_bin + c, self._last_bin.get(source, now_bin + c))
        env = self._env.get(source, {})
        return [env.get(hi - i, SILENCE_DBFS) for i in range(0, 2 * self._lag + 1)]

    def _still_dominated(self, speaker: str, now_bin: int) -> bool:
        source = self._source.get(speaker)
        if source is None:
            return False
        a = max(self._aligned_recent(source, speaker, now_bin))
        return (
            a > self._active and a - self._recent_peak(speaker, now_bin) >= self._diff
        )

    def _sounds_like_own_voice(self, speaker: str, now_bin: int) -> bool:
        """B's current frame carries a voice nearly as loud as A's own mic ->
        B is talking (e.g. an interjection over A), not a leak."""
        source = self._source.get(speaker)
        if source is None:
            return False
        b_now = self._env.get(speaker, {}).get(now_bin, SILENCE_DBFS)
        if b_now <= self._active:
            return False  # pauses: both mics near the noise floor
        # A's frames may arrive later than B's (network skew), so at the onset
        # of A's word the leak in B can precede A's own frames. Own speech
        # into a close mic also rises far above the leak level seen so far.
        leak = self._leak_level.get(speaker, self._active)
        if b_now < leak + self._own_rise:
            return False
        # Compare with A's typical recent level (not its peak, which a softer
        # talker's syllables rarely reach): a leak sits ~20 dB below it.
        recent = [
            v
            for v in self._aligned_recent(source, speaker, now_bin)
            if v > self._active
        ]
        a_level = float(np.median(recent)) if recent else SILENCE_DBFS
        return b_now >= a_level - self._own_margin

    def _evaluate(self, speaker: str, now_bin: int) -> str | None:
        """Return the speaker whose voice leaks into `speaker`'s mic, if any."""
        for other in self._env:
            if other == speaker:
                continue
            c = self._center(speaker, other)
            # Around the pair's measured alignment, with the reverb tolerance.
            hit, lag = self._match(speaker, other, now_bin, c, self._lag)
            if lag is not None:
                self._vote(speaker, other, lag, now_bin)
            if not hit and self._off > self._lag:
                # Discover (or re-measure) the alignment over the whole
                # plausible offset range. This only measures: judging over
                # such a wide range would match independent speech by chance.
                _, lag = self._match(speaker, other, now_bin, 0, self._off, flag=False)
                if lag is not None:
                    self._vote(speaker, other, lag, now_bin)
            if hit:
                return other
        return None

    def _match(
        self,
        speaker: str,
        other: str,
        now_bin: int,
        c: int,
        reach: int,
        *,
        flag: bool = True,
    ) -> tuple[bool, int | None]:
        """Is `other`'s voice in `speaker`'s mic, at source offset c +/- reach?

        Returns (hit, offset in bins of the best match when it is good enough
        to vote on the pair's alignment, else None). Votes need agreement
        (ALIGN_AGREE within ALIGN_TOL bins) before they move the alignment.
        With flag=False the call only measures (votes), it never flags."""
        # End the window late enough that `other`'s matching frames (which
        # may arrive later than ours) are already here.
        a_last = self._last_bin.get(other, now_bin)
        end = min(now_bin, a_last - c) - reach
        start = end - self._win
        b = self._series(speaker, start, self._win)
        b_active = b[b > self._active]
        # A sparse window (pauses) can still be measured, not judged.
        if b_active.size < self._win * self.VOTE_ACTIVE:
            return False, None
        b_level = float(np.median(b_active))
        if float(np.std(b)) < 1e-3:
            return False, None
        a_ext = self._series(other, start + c - reach, self._win + 2 * reach)
        a_core = a_ext[reach : reach + self._win]
        a_active = a_core[a_core > self._active]
        if a_active.size < self._win * self.VOTE_ACTIVE:
            return False, None
        if float(np.median(a_active)) - b_level < self._diff:
            return False, None
        windows = np.lib.stride_tricks.sliding_window_view(
            np.maximum(a_ext, self._floor), self._win
        )
        corrs = _corrs(np.maximum(b, self._floor), windows)
        if corrs.size == 0:
            return False, None
        k = int(np.argmax(corrs))
        corr = float(corrs[k])
        vote = c + k - reach if corr >= self._align_corr else None
        judged = min(b_active.size, a_active.size) >= self._win * 0.3
        if not flag or not judged:
            return False, vote
        if corr >= self._corr:
            self._last_b_level = b_level
            return True, vote
        if corr < self._corr_relaxed:
            return False, vote
        # Reverb smears the leaked envelope, so correlation alone misses
        # fluent speech. Physics helps: a leak is never close to its
        # source's level, so B stays `bound_margin_db` below A's recent
        # peak (+/- lag around the alignment) in nearly every active bin.
        # B's own voice breaks that bound constantly.
        lo = reach - self._lag
        a_peak = np.lib.stride_tricks.sliding_window_view(a_ext, 2 * self._lag + 1).max(
            axis=1
        )[lo : lo + self._win]
        mask = b > self._active
        bounded = float(np.mean(b[mask] <= a_peak[mask] - self._bound_margin))
        if bounded >= self._bounded_ratio:
            self._last_b_level = b_level
            return True, vote
        return False, vote


def _corrs(b: np.ndarray, windows: np.ndarray) -> np.ndarray:
    """Pearson correlation of `b` with each row of `windows`."""
    bc = b - b.mean()
    bn = float(np.sqrt(np.sum(bc * bc)))
    if bn < 1e-6:
        return np.zeros(len(windows), dtype=np.float32)
    wc = windows - windows.mean(axis=1, keepdims=True)
    wn = np.sqrt(np.sum(wc * wc, axis=1))
    with np.errstate(divide="ignore", invalid="ignore"):
        c = (wc @ bc) / (wn * bn)
    return np.nan_to_num(c, nan=0.0, posinf=0.0, neginf=0.0)


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
            if chunk.bleed:
                # Only someone else's voice is coming in: the hangover exists to
                # let THIS speaker finish, not to forward a neighbour's speech.
                self._open = False
                self._pre_roll.append(chunk)
                return []
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
        self._n_speech = 0  # frames of the speaker's own (unflagged) speech
        self._n_bleed = 0  # speech-like frames flagged as someone else's voice
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
        if speech:
            self._n_speech += 1
        elif bleed:
            self._n_bleed += 1
        while len(self._buf) >= self._chunk_bytes:
            out = bytes(self._buf[: self._chunk_bytes])
            del self._buf[: self._chunk_bytes]
            # Majority vote: one stray unflagged frame inside a leaked chunk
            # must not open the gate (it would forward the pre-roll of the
            # neighbour's voice). With no bleed flags this is "any speech".
            own = self._n_speech > 0 and self._n_speech >= self._n_bleed
            chunk = InputChunk(
                pcm=out,
                sample_rate=self.sample_rate,
                speech=own,
                bleed=self._n_bleed > 0 and not own,
                ts=self._ts if self._ts is not None else ts,
            )
            self._push(chunk)
            self._n_speech = 0
            self._n_bleed = 0
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


class LevelHistory:
    """The last few seconds of one mic's per-frame loudness.

    Used by the cross-talk detector to tell which of two mics carrying the
    same words is the near one; independent of the bleed guard's switch."""

    def __init__(self, keep_sec: float = 8.0) -> None:
        self._keep = keep_sec
        self._items: deque[tuple[float, float]] = deque()

    def add(self, ts: float, level_db: float) -> None:
        self._items.append((ts, level_db))
        cutoff = ts - self._keep
        while self._items and self._items[0][0] < cutoff:
            self._items.popleft()

    def loudness(self, since: float, q: float = 80.0) -> float | None:
        """`q`-th percentile dBFS of frames since `since` (None if < 0.2 s)."""
        vals = [lv for ts, lv in self._items if ts >= since]
        if len(vals) < 20:
            return None
        return float(np.percentile(vals, q))


class SpeakerInput:
    """Reads one speaker's mic once and fans it out to sessions."""

    def __init__(
        self,
        *,
        identity: str,
        frames: AsyncIterator[bytes],
        settings: Settings,
        bleed_guard: BleedGuard | None = None,
        crosstalk: Any = None,
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
        # crosstalk.CrossTalkDetector (typed loosely: audio.py stays import-free).
        self._crosstalk = crosstalk
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
        self.withheld_frames = 0  # kept from the provider: overheard voice (crosstalk)
        self.levels = LevelHistory()

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
        self.levels.add(now, level)
        withheld = False
        if self._crosstalk is not None:
            try:
                self._crosstalk.note_level(self.identity, level, now)
                # Overheard voice on a held mic: don't let the provider hear it
                # (its memory stays one voice, one language); the owner's own,
                # clearly louder voice still goes through.
                withheld = self._crosstalk.withhold(self.identity, level)
            except Exception:  # never let the side check break capture
                logger.debug("crosstalk level update failed", exc_info=True)
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
        if withheld:
            self.withheld_frames += 1
        speech = vad_speech and not bleed and not withheld
        bleed = bleed or withheld
        if bleed and not withheld:
            self.bleed_frames += 1
            if self._crosstalk is not None and self._guard is not None:
                # Hand the guard's finding to the words check: it keeps the
                # stream muted for the whole stretch, including the parts the
                # guard misses (live simulation 2026-11-17: with the guard
                # chopping the leak, too few words reached the provider and
                # 5 wrong captions stayed on screen).
                try:
                    self._crosstalk.note_guard_leak(
                        self.identity, self._guard.source_of(self.identity), now
                    )
                except Exception:
                    logger.debug("crosstalk guard hand-off failed", exc_info=True)

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

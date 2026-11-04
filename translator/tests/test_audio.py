"""VAD, input gate, bleed guard, chunking and backlog control."""

from __future__ import annotations

import numpy as np
import pytest
from helpers import FAST, frames_of, silence, speech_like

from audio import (
    BacklogController,
    BleedGuard,
    EnergyVad,
    InputChunk,
    InputGate,
    SpeakerInput,
    Subscription,
    energy_dbfs,
    simple_resampler_factory,
)


def _chunk(
    ts: float, speech: bool, bleed: bool = False, ms: int = 100, rate: int = 16000
) -> InputChunk:
    return InputChunk(
        pcm=b"\x01\x00" * (rate * ms // 1000),
        sample_rate=rate,
        speech=speech,
        bleed=bleed,
        ts=ts,
    )


# --- VAD ---------------------------------------------------------------------


def test_vad_fails_open_before_floor_exists():
    vad = EnergyVad()
    assert vad.update(-30.0) is True  # no floor yet -> speech


def test_vad_detects_speech_over_noise_floor():
    vad = EnergyVad()
    noise = silence(3.0)
    speech = speech_like(2.0, seed=3)
    results_noise = [
        vad.update(energy_dbfs(np.frombuffer(f, np.int16))) for f in frames_of(noise)
    ]
    results_speech = [
        vad.update(energy_dbfs(np.frombuffer(f, np.int16))) for f in frames_of(speech)
    ]
    assert (
        sum(results_noise[-100:]) == 0
    )  # quiet noise is not speech once the floor exists
    assert sum(results_speech) / len(results_speech) > 0.5


# --- Input gate --------------------------------------------------------------


def test_gate_disabled_passes_everything_unchanged_even_bleed():
    gate = InputGate(enabled=False, pre_roll_ms=600, hangover_ms=2500, chunk_ms=100)
    out = gate.process(_chunk(0.0, speech=False))
    assert len(out) == 1
    flagged = _chunk(0.1, speech=False, bleed=True)
    assert gate.process(flagged) == [flagged]  # never erase audio without pre-roll


def test_gate_withholds_silence_and_sends_pre_roll_on_onset():
    gate = InputGate(enabled=True, pre_roll_ms=300, hangover_ms=500, chunk_ms=100)
    sent = []
    for i in range(10):  # 1 s of silence
        sent += gate.process(_chunk(i * 0.1, speech=False))
    assert sent == []
    burst = gate.process(_chunk(1.0, speech=True))
    # 3 pre-roll chunks (300 ms) + the speech chunk -> onset never clipped
    assert len(burst) == 4
    assert [c.ts for c in burst] == pytest.approx([0.7, 0.8, 0.9, 1.0])


def test_gate_bleed_flag_delays_but_does_not_lose_following_speech():
    gate = InputGate(enabled=True, pre_roll_ms=600, hangover_ms=500, chunk_ms=100)
    # 300 ms wrongly flagged as bleed, then the speaker is clearly detected.
    assert gate.process(_chunk(0.0, speech=False, bleed=True)) == []
    assert gate.process(_chunk(0.1, speech=False, bleed=True)) == []
    assert gate.process(_chunk(0.2, speech=False, bleed=True)) == []
    out = gate.process(_chunk(0.3, speech=True))
    assert [c.ts for c in out] == pytest.approx([0.0, 0.1, 0.2, 0.3])


def test_gate_hangover_keeps_sending_then_closes():
    gate = InputGate(enabled=True, pre_roll_ms=200, hangover_ms=500, chunk_ms=100)
    gate.process(_chunk(0.0, speech=True))
    kept = [gate.process(_chunk(0.1 * i, speech=False)) for i in range(1, 6)]
    assert all(len(x) == 1 for x in kept)  # within hangover
    assert gate.process(_chunk(0.7, speech=False)) == []  # hangover expired
    assert not gate.is_open


def test_gate_never_waits_for_utterance_end_during_speech():
    gate = InputGate(enabled=True, pre_roll_ms=200, hangover_ms=500, chunk_ms=100)
    outputs = [
        gate.process(_chunk(0.1 * i, speech=True)) for i in range(200)
    ]  # 20 s monologue
    assert all(len(o) >= 1 for o in outputs)


# --- Subscription chunking -----------------------------------------------------------


def test_subscription_emits_fixed_chunks_and_drops_oldest_when_full():
    sub = Subscription(sample_rate=16000, chunk_ms=100, max_queue=3)
    frame = b"\x00\x00" * 160  # 10 ms @16k
    for i in range(10 * 5):  # 500 ms
        sub.feed(frame, speech=(i > 20), bleed=False, ts=i * 0.01)
    assert sub.queue.qsize() == 3
    assert sub.dropped_chunks == 2
    chunk = sub.queue.get_nowait()
    assert len(chunk.pcm) == 3200


# --- Bleed guard ---------------------------------------------------------------


def _env(samples: np.ndarray) -> list[float]:
    return [energy_dbfs(np.frombuffer(f, np.int16)) for f in frames_of(samples)]


def _room_leak(a: np.ndarray, db: float, seed: int) -> np.ndarray:
    """A's voice as heard by a neighbour's mic: early echoes + diffuse tail,
    attenuated by `db`, plus mic noise."""
    rng = np.random.default_rng(seed)
    n = int(0.15 * 48000)
    ir = np.zeros(n)
    ir[0] = 1.0
    for d, g in ((0.007, 0.5), (0.013, 0.35), (0.021, 0.25)):
        ir[int(d * 48000)] += g
    ir += (
        rng.normal(0, 1, n) * np.exp(-np.arange(n) / (0.04 * 48000)) * 10 ** (-15 / 20)
    )
    x = np.convolve(a.astype(np.float32), ir)[: len(a)]
    x = x / (np.max(np.abs(x)) + 1e-9) * np.max(np.abs(a)) * 10 ** (-db / 20)
    return (x + silence(len(a) / 48000, noise=10, seed=seed + 7)).astype(np.int16)


def _run_guard(
    a: np.ndarray, b: np.ndarray, *, b_lag_frames: int = 4
) -> tuple[int, int]:
    """Feed A and B (B delayed by lag) into the guard; return (#B flagged, #B evaluated)."""
    guard = BleedGuard(enabled=True)
    ea, eb = _env(a), _env(b)
    flagged = evaluated = 0
    for i in range(len(ea)):
        ts = i * 0.01
        guard.update("A", ea[i], ts)
        j = i - b_lag_frames
        if j >= 0:
            guard.update("B", eb[j], ts)
            if i > 150 and eb[j] > -50:
                evaluated += 1
                flagged += guard.is_bleed("B", ts)
    return flagged, evaluated


@pytest.mark.parametrize("seed", [0, 1, 2, 3])
@pytest.mark.parametrize("db", [15, 18])
def test_bleed_guard_flags_room_leak_of_louder_speaker(seed, db):
    a = speech_like(6.0, seed=10 + seed, level=0.3)
    flagged, evaluated = _run_guard(a, _room_leak(a, db, seed))
    assert evaluated > 0
    assert flagged / evaluated > 0.6


@pytest.mark.parametrize("seed", range(6))
@pytest.mark.parametrize("db", [0, 6, 12])
def test_bleed_guard_never_flags_independent_speech(seed, db):
    # B speaks independently while A talks: at the same level, or softly
    # (down to 12 dB quieter at B's own mic). Must never be suppressed.
    a = speech_like(6.0, seed=10 + seed, level=0.3)
    b = speech_like(6.0, seed=300 + 7 * seed + db, level=0.3 * 10 ** (-db / 20))
    flagged, evaluated = _run_guard(a, b)
    assert evaluated > 0
    assert flagged == 0


def test_bleed_guard_disabled():
    guard = BleedGuard(enabled=False)
    guard.update("A", -10.0, 0.0)
    assert guard.is_bleed("A", 0.0) is False


# --- Speaker input integration (VAD + guard + fan-out) ----------------------------------


def test_speaker_input_fans_out_once_per_rate_and_detects_onset():
    onsets = []
    inp = SpeakerInput(
        identity="s1",
        frames=None,  # type: ignore[arg-type]
        settings=FAST,
        on_onset=lambda ident, ts: onsets.append((ident, ts)),
        resampler_factory=simple_resampler_factory,
    )
    a = inp.subscribe(sample_rate=16000, chunk_ms=100)
    b = inp.subscribe(sample_rate=16000, chunk_ms=100)
    c = inp.subscribe(sample_rate=24000, chunk_ms=100)
    audio = np.concatenate([silence(1.0), speech_like(1.0, seed=5)])
    for i, f in enumerate(frames_of(audio)):
        inp.process_frame(f, ts=i * 0.01)
    assert len(inp._resamplers) == 2  # one per distinct rate, shared by sessions
    assert a.queue.qsize() == b.queue.qsize() == 20
    assert c.queue.qsize() == 20
    assert len(c.queue.get_nowait().pcm) == 2400 * 2
    assert len(onsets) >= 1 and onsets[0][1] >= 0.9


# --- Backlog --------------------------------------------------------------------------------


def test_backlog_passes_through_under_soft_limit():
    bc = BacklogController(soft_ms=2500, hard_ms=6000, keep_silence_ms=150)
    pcm = speech_like(0.5, rate=24000).tobytes()
    assert bc.process(pcm, sample_rate=24000, queued_ms=100) == pcm


def test_backlog_trims_long_silence_above_soft_limit():
    bc = BacklogController(soft_ms=2500, hard_ms=6000, keep_silence_ms=150)
    pcm = np.concatenate(
        [
            speech_like(0.3, rate=24000),
            np.zeros(24000, np.int16),
            speech_like(0.3, rate=24000, seed=2),
        ]
    ).tobytes()
    out = bc.process(pcm, sample_rate=24000, queued_ms=3000)
    out_ms = len(out) / 2 / 24000 * 1000
    assert out_ms < 1000  # 1 s silence cut to ~150 ms (+ speech)
    assert bc.trimmed_ms > 700


def test_backlog_drops_pure_silence_only_when_nothing_is_playing():
    bc = BacklogController(soft_ms=2500, hard_ms=6000, keep_silence_ms=150)
    quiet = np.zeros(2400, np.int16).tobytes()
    assert (
        bc.process(quiet, sample_rate=24000, queued_ms=0) == b""
    )  # leading silence burst
    assert (
        bc.process(quiet, sample_rate=24000, queued_ms=500) == quiet
    )  # pause inside speech kept
    speech = speech_like(0.1, rate=24000).tobytes()
    assert bc.process(speech, sample_rate=24000, queued_ms=0) == speech


def test_backlog_drops_above_hard_limit_and_counts():
    bc = BacklogController(soft_ms=2500, hard_ms=6000, keep_silence_ms=150)
    pcm = speech_like(0.2, rate=24000).tobytes()
    assert bc.process(pcm, sample_rate=24000, queued_ms=6500) == b""
    assert abs(bc.dropped_ms - 200) < 1

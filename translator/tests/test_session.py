"""TranslationSession behaviour with the deterministic mock provider."""

from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest
from helpers import (
    fast,
    frames_of,
    paced_then_silence,
    rms,
    silence,
    speech_like,
    wait_for,
)

from audio import SpeakerInput, simple_resampler_factory
from events import FakeRoomIO
from providers.base import AudioOut, TranscriptOut
from providers.mock import MockProvider
from session import SessionKey, TranslationSession


def make_input(
    audio: np.ndarray, *, identity: str = "spk", start_delay: float = 0.0, settings=None
) -> SpeakerInput:
    settings = settings or fast()
    inp = SpeakerInput(
        identity=identity,
        frames=paced_then_silence(frames_of(audio), start_delay=start_delay),
        settings=settings,
        resampler_factory=simple_resampler_factory,
    )
    return inp


def key(speaker: str = "spk", target: str = "pl") -> SessionKey:
    return SessionKey("g1", "grp1", speaker, target)


def track_sink(io: FakeRoomIO, name: str):
    for tname, sink in io.tracks.values():
        if tname == name:
            return sink
    raise AssertionError(f"track {name} not published: {io.track_names()}")


def first_loud_write(sink, threshold: float = 300.0) -> float | None:
    for ts, pcm in sink.written:
        if rms(pcm) > threshold:
            return ts
    return None


async def start_session(inp, providers, io, settings=None, **kw) -> TranslationSession:
    s = TranslationSession(
        key=kw.pop("key", key()),
        speaker_input=inp,
        providers=providers,
        echo_target=kw.pop("echo", False),
        room_io=io,
        settings=settings or fast(),
        resampler_factory=simple_resampler_factory,
        **kw,
    )
    await s.start()
    return s


async def test_translation_starts_before_speaker_finishes():
    """Release gate: output audio flows while the source is still speaking."""
    speech = np.concatenate([silence(0.5), speech_like(4.0, seed=7)])
    inp = make_input(speech)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=300)
    session = await start_session(inp, [provider], io)
    t0 = time.monotonic()
    inp.start()
    source_end = t0 + 4.5
    sink = track_sink(io, "tx:spk:pl")
    assert await wait_for(lambda: first_loud_write(sink) is not None, timeout=6)
    first = first_loud_write(sink)
    assert first < source_end - 2.0, (
        "translated audio must begin long before the source ends"
    )
    # Output keeps flowing incrementally (many writes before the source ends).
    await asyncio.sleep(max(0.0, source_end - time.monotonic()))
    loud_before_end = [
        ts for ts, pcm in sink.written if ts < source_end and rms(pcm) > 300
    ]
    assert len(loud_before_end) >= 20
    await session.aclose()
    await inp.aclose()
    assert session.state == "stopped"


async def test_overlapping_speakers_are_independent():
    """A talks 4 s; B interjects at 1.0 s for 0.8 s. B's translation must not
    wait for A to finish."""
    a_audio = np.concatenate([silence(0.3), speech_like(4.0, seed=1)])
    b_audio = np.concatenate(
        [silence(0.3), silence(1.0), speech_like(0.8, seed=2), silence(3.0)]
    )
    inp_a = make_input(a_audio, identity="A")
    inp_b = make_input(b_audio, identity="B")
    io = FakeRoomIO()
    sa = await start_session(
        inp_a, [MockProvider(delay_ms=300)], io, key=key("A", "pl")
    )
    sb = await start_session(
        inp_b, [MockProvider(delay_ms=300)], io, key=key("B", "es")
    )
    t0 = time.monotonic()
    inp_a.start()
    inp_b.start()
    a_end = t0 + 4.3
    sink_a = track_sink(io, "tx:A:pl")
    sink_b = track_sink(io, "tx:B:es")
    assert await wait_for(lambda: first_loud_write(sink_b) is not None, timeout=6)
    assert first_loud_write(sink_b) < a_end - 1.0
    # A's translation kept flowing during B's interjection.
    b_first = first_loud_write(sink_b)
    a_during = [
        ts
        for ts, pcm in sink_a.written
        if b_first - 0.5 < ts < b_first + 0.5 and rms(pcm) > 300
    ]
    assert a_during, (
        "the main speaker's translation must continue through the interjection"
    )
    for s in (sa, sb):
        await s.aclose()
    for i in (inp_a, inp_b):
        await i.aclose()


async def test_keepalive_keeps_a_quiet_speakers_stream_open():
    """Gemini closes a stream after 120 s without audio, and the input gate
    withholds silence. A quiet participant's stream must get a short silent
    chunk every `stream_keepalive_sec` instead of dropping and reconnecting."""
    settings = fast(stream_keepalive_sec=1.0)
    inp = make_input(silence(5.0), settings=settings)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=100)
    session = await start_session(inp, [provider], io, settings=settings)
    inp.start()
    assert await wait_for(lambda: provider.streams, timeout=2)
    stream = provider.streams[0]
    assert await wait_for(lambda: stream.received_chunks >= 2, timeout=6)
    # Only keepalives were sent: about one 50 ms chunk per second, all silent.
    assert stream.received_chunks <= 6
    assert stream.received_seconds == pytest.approx(
        stream.received_chunks * 0.05, abs=1e-6
    )
    assert provider.connect_calls == 1
    assert session.meter.input_seconds == pytest.approx(stream.received_seconds)
    await session.aclose()
    await inp.aclose()


async def test_keepalive_disabled_sends_nothing_during_silence():
    settings = fast(stream_keepalive_sec=0.0)
    inp = make_input(silence(3.0), settings=settings)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=100)
    session = await start_session(inp, [provider], io, settings=settings)
    inp.start()
    assert await wait_for(lambda: provider.streams, timeout=2)
    await asyncio.sleep(2.5)
    assert provider.streams[0].received_chunks == 0
    await session.aclose()
    await inp.aclose()


def _loud(seconds: float = 0.2) -> bytes:
    return speech_like(seconds, rate=24000, seed=5).tobytes()


async def test_output_of_speech_already_in_the_target_language_is_dropped():
    """A neighbour's Spanish leaking into a Polish speaker's mic, labelled 'es'
    by the provider, must not be re-voiced to the Spanish listener."""
    inp = make_input(silence(3.0))
    io = FakeRoomIO()
    session = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("spk", "es")
    )
    sink = track_sink(io, "tx:spk:es")
    await session._on_transcript(TranscriptOut(kind="input", text="x", lang="es"))
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert not any(rms(p) > 300 for _, p in sink.written)
    assert session.same_language_dropped_sec > 0
    # The speaker's own language comes back: translation flows again.
    await session._on_transcript(TranscriptOut(kind="input", text="y", lang="pl-PL"))
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert any(rms(p) > 300 for _, p in sink.written)
    await session.aclose()
    await inp.aclose()


async def test_captions_that_went_out_before_the_language_label_are_retracted():
    """Live two-phone test 2026-11-17: the re-voiced audio was dropped, but its
    captions had already been shown under the wrong person's name."""
    inp = make_input(silence(3.0))
    io = FakeRoomIO()
    session = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("spk", "es")
    )
    # Output text arrives first, the input's language label only afterwards.
    await session._on_transcript(TranscriptOut(kind="output", text="hola, ¿qué"))
    await session._on_transcript(TranscriptOut(kind="input", text="x", lang="es"))
    # While held, further output text is not published at all.
    await session._on_transcript(TranscriptOut(kind="output", text="tal?"))
    await session._flush_outbox()
    shown = [c for c in io.captions if c["kind"] == "translation"]
    assert [c["text"] for c in shown if c["text"]] == ["hola, ¿qué"]
    retract = [c for c in shown if c.get("retract") == "true"]
    assert len(retract) == 1
    assert retract[0]["seg"] == shown[0]["seg"]
    assert retract[0]["final"] == "true"
    # The next real translation starts a new segment.
    await session._on_transcript(TranscriptOut(kind="input", text="y", lang="pl"))
    await session._on_transcript(TranscriptOut(kind="output", text="bien"))
    await session._flush_outbox()
    last = [c for c in io.captions if c["kind"] == "translation"][-1]
    assert last["text"] == "bien" and last["seg"] != shown[0]["seg"]
    await session.aclose()
    await inp.aclose()


async def test_overheard_words_mute_the_stream_and_withdraw_its_captions():
    """Three-language table: Ola's (pl) mic overhears Ian (es). Her stream to
    English must not re-voice Ian, and what it already showed is withdrawn."""
    from crosstalk import CrossTalkDetector

    inp = make_input(silence(4.0), identity="ola")
    io = FakeRoomIO()
    det = CrossTalkDetector(hold_sec=1.0)
    det.set_declared("ian", "es")
    det.set_declared("ola", "pl")
    session = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("ola", "en"), crosstalk=det
    )
    session.crosstalk_feed = True
    det.on_hold = lambda who: session.crosstalk_started() if who == "ola" else None
    sink = track_sink(io, "tx:ola:en")

    # Ola's English stream starts re-voicing Ian before anyone can tell.
    await session._on_transcript(TranscriptOut(kind="output", text="tomorrow we"))
    words = [
        "Mañana",
        "vamos",
        "a",
        "comer",
        "empanadas",
        "en",
        "la",
        "casa",
        "de",
        "mi",
        "madre",
    ]
    for i in range(0, len(words), 3):
        det.note_input("ian", " ".join(words[i : i + 3]), "es")
        await session._on_transcript(
            TranscriptOut(kind="input", text=" ".join(words[i : i + 3]), lang="es")
        )
    assert det.is_held("ola")
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    await session._on_transcript(TranscriptOut(kind="output", text="eat empanadas"))
    await session._flush_outbox()
    assert not any(rms(p) > 300 for _, p in sink.written)
    assert session.crosstalk_dropped_sec > 0
    shown = [c for c in io.captions if c["kind"] == "translation"]
    assert [c["text"] for c in shown if c["text"]] == ["tomorrow we"]
    assert any(
        c.get("retract") == "true" and c["seg"] == shown[0]["seg"] for c in shown
    )

    # The hold (and the tail after it) lapse once the shared words stop and the
    # overheard translation pauses: her own speech flows again.
    await asyncio.sleep(1.4)
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert any(rms(p) > 300 for _, p in sink.written)
    await session.aclose()
    await inp.aclose()


async def _overhearing_session(hold_sec: float):
    from crosstalk import CrossTalkDetector

    inp = make_input(silence(5.0), identity="ola")
    io = FakeRoomIO()
    det = CrossTalkDetector(hold_sec=hold_sec)
    det.set_declared("ian", "es")
    det.set_declared("ola", "pl")
    session = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("ola", "en"), crosstalk=det
    )
    session.crosstalk_feed = True
    det.on_hold = lambda who: session.crosstalk_started() if who == "ola" else None
    words = [
        "Mañana",
        "vamos",
        "a",
        "comer",
        "empanadas",
        "en",
        "la",
        "casa",
        "de",
        "mi",
        "madre",
    ]
    for i in range(0, len(words), 3):
        det.note_input("ian", " ".join(words[i : i + 3]), "es")
        await session._on_transcript(
            TranscriptOut(kind="input", text=" ".join(words[i : i + 3]), lang="es")
        )
    assert det.is_held("ola")
    return inp, io, det, session, track_sink(io, "tx:ola:en")


async def test_the_overheard_translation_tail_is_dropped_until_it_pauses():
    """The provider keeps voicing the overheard speech for seconds after the
    shared words stop; that tail must not reach the listener either."""
    inp, _io, det, session, sink = await _overhearing_session(hold_sec=0.3)
    for _ in range(6):  # continuous output for ~0.9 s, outliving the 0.3 s hold
        await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
        await asyncio.sleep(0.15)
    assert not det.is_held("ola")
    assert not any(rms(p) > 300 for _, p in sink.written)
    await asyncio.sleep(1.3)  # the overheard translation paused
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert any(rms(p) > 300 for _, p in sink.written)
    await session.aclose()
    await inp.aclose()


async def test_own_words_cut_the_tail_short():
    inp, _io, det, session, sink = await _overhearing_session(hold_sec=3.0)
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert not any(rms(p) > 300 for _, p in sink.written)
    det.note_input("ola", "Czekaj, poczekajcie chwilę, muszę zadzwonić", "pl")
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert any(rms(p) > 300 for _, p in sink.written)
    await session.aclose()
    await inp.aclose()


async def test_echo_sessions_keep_same_language_output():
    """'I switch languages' speakers use echo sessions on purpose."""
    inp = make_input(silence(3.0))
    io = FakeRoomIO()
    session = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("spk", "es"), echo=True
    )
    sink = track_sink(io, "tx:spk:es")
    await session._on_transcript(TranscriptOut(kind="input", text="x", lang="es"))
    await session._on_audio(AudioOut(pcm=_loud(), sample_rate=24000))
    assert any(rms(p) > 300 for _, p in sink.written)
    await session.aclose()
    await inp.aclose()


async def test_reconnects_after_provider_drop_and_keeps_streaming():
    speech = speech_like(4.0, seed=3)
    inp = make_input(speech)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=200, drop_after_sec=1.2)
    session = await start_session(inp, [provider], io)
    inp.start()
    assert await wait_for(lambda: provider.connect_calls >= 2, timeout=5)
    sink = track_sink(io, "tx:spk:pl")
    reconnect_at = time.monotonic()
    assert await wait_for(
        lambda: any(ts > reconnect_at and rms(p) > 300 for ts, p in sink.written),
        timeout=4,
    )
    states = [e["state"] for e in io.events if e.get("t") == "session"]
    assert "reconnecting" in states
    await session.aclose()
    await inp.aclose()


async def test_goaway_rotates_make_before_break():
    speech = speech_like(4.0, seed=4)
    inp = make_input(speech)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=200, goaway_after_sec=1.0)
    session = await start_session(inp, [provider], io)
    inp.start()
    assert await wait_for(lambda: session.rotations == 1, timeout=5)
    assert provider.connect_calls == 2
    old, new = provider.streams
    await asyncio.sleep(0.6)  # > rotation_drain_sec
    assert old._closed
    assert new.received_chunks > 0, "input switched to the new stream"
    states = [e["state"] for e in io.events if e.get("t") == "session"]
    assert "reconnecting" not in states, "rotation must not interrupt the stream"
    await session.aclose()
    await inp.aclose()


async def test_falls_back_to_secondary_provider_after_repeated_failures():
    speech = speech_like(3.0, seed=5)
    inp = make_input(speech)
    io = FakeRoomIO()
    primary = MockProvider(delay_ms=200, fail_connects=99, name="gemini")
    secondary = MockProvider(delay_ms=200, name="openai")
    session = await start_session(
        inp,
        [primary, secondary],
        io,
        settings=fast(provider_failures_before_fallback=3),
    )
    inp.start()
    assert await wait_for(lambda: secondary.connect_calls >= 1, timeout=5)
    assert primary.connect_calls == 3
    sink = track_sink(io, "tx:spk:pl")
    assert await wait_for(lambda: first_loud_write(sink) is not None, timeout=5)
    assert session.provider.name == "openai"
    await session.aclose()
    await inp.aclose()


async def test_emits_first_audio_latency_event():
    speech = np.concatenate([silence(1.0), speech_like(2.0, seed=6)])
    inp = make_input(speech)
    io = FakeRoomIO()
    session = await start_session(inp, [MockProvider(delay_ms=400)], io)
    inp.start()
    assert await wait_for(
        lambda: any(e.get("t") == "first_audio" for e in io.events), timeout=5
    )
    ev = next(e for e in io.events if e.get("t") == "first_audio")
    # Mock delay 400 ms + gate pre-roll alignment; must be close to the delay.
    assert 250 <= ev["latencyMs"] <= 1200
    assert ev["speaker"] == "spk" and ev["target"] == "pl" and ev["provider"] == "mock"
    assert session.meter.first_audio_ms
    await session.aclose()
    await inp.aclose()


async def test_captions_follow_contract_and_source_only_when_designated():
    speech = speech_like(2.5, seed=8)
    inp = make_input(speech)
    io = FakeRoomIO()
    s1 = await start_session(
        inp, [MockProvider(delay_ms=100)], io, key=key("spk", "en"), publish_source=True
    )
    s2 = await start_session(
        inp,
        [MockProvider(delay_ms=100)],
        io,
        key=key("spk", "pl"),
        publish_source=False,
    )
    inp.start()
    assert await wait_for(
        lambda: any(c["final"] == "true" for c in io.captions), timeout=6
    )
    translations = [c for c in io.captions if c["kind"] == "translation"]
    sources = [c for c in io.captions if c["kind"] == "source"]
    assert translations and sources
    assert {c["target_lang"] for c in translations} == {"en", "pl"}
    assert all(
        c["sender"] == "spk" and c["source_identity"] == "spk" for c in io.captions
    )
    assert all(
        set(c)
        >= {
            "kind",
            "source_identity",
            "target_lang",
            "source_lang",
            "final",
            "seg",
            "provider",
        }
        for c in io.captions
    )
    # Only the designated session publishes kind=source -> no duplicates.
    assert {c["target_lang"] for c in sources} == {""}
    assert (
        len(sources) <= len([c for c in translations if c["target_lang"] == "en"]) + 2
    )
    for s in (s1, s2):
        await s.aclose()
    await inp.aclose()


@pytest.mark.parametrize("gating", [True, False])
async def test_input_gate_skips_silence_only_for_gating_providers(gating):
    speech = np.concatenate([speech_like(1.0, seed=9), silence(2.5)])
    inp = make_input(speech)
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=100, allows_input_gating=gating)
    session = await start_session(inp, [provider], io)
    inp.start()
    await asyncio.sleep(3.6)
    sent = provider.streams[0].received_seconds
    if gating:
        # 1 s speech + 0.6 s hangover (+ pre-roll); the rest of the silence is withheld.
        assert sent < 2.6
    else:
        assert sent > 3.0
    await session.aclose()
    await inp.aclose()


async def test_close_unpublishes_track_and_closes_provider():
    inp = make_input(speech_like(1.0))
    io = FakeRoomIO()
    provider = MockProvider(delay_ms=100)
    session = await start_session(inp, [provider], io)
    inp.start()
    assert await wait_for(lambda: provider.connect_calls == 1)
    await asyncio.sleep(0.2)
    await session.aclose()
    assert io.tracks == {}
    assert provider.streams[0]._closed
    assert [e for e in io.events if e.get("state") == "stopped"]
    await inp.aclose()

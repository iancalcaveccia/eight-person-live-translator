"""Gemini Live Translate wire protocol against a fake WebSocket server."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import time

import numpy as np
import pytest
from helpers import fast, frames_of, paced_then_silence, rms, speech_like, wait_for
from websockets.asyncio.server import serve

from audio import SpeakerInput, simple_resampler_factory
from events import FakeRoomIO
from providers.base import (
    AudioOut,
    GoAway,
    SegmentEnd,
    SetupRejectedError,
    TranscriptOut,
)
from providers.gemini import (
    LAYOUT_GENERATION_CONFIG,
    LAYOUT_SETUP,
    GeminiProvider,
    _LayoutState,
    build_setup_payload,
    parse_server_message,
)
from session import SessionKey, TranslationSession


class FakeGemini:
    """Speaks just enough BidiGenerateContent to test the client."""

    def __init__(
        self,
        *,
        reject_layout: str | None = None,
        goaway_after_msgs: int | None = None,
        drop_after_msgs: int | None = None,
    ):
        self.reject_layout = reject_layout
        self.goaway_after = goaway_after_msgs
        self.drop_after = drop_after_msgs
        self.setups: list[dict] = []
        self.headers: list[dict] = []
        self.audio_msgs: list[list[float]] = []  # per connection: arrival times
        self.connections = 0
        self.server = None
        self.url = ""

    async def handler(self, ws):
        self.connections += 1
        conn = self.connections
        self.headers.append(dict(ws.request.headers))
        setup = json.loads(await ws.recv())
        self.setups.append(setup)
        s = setup["setup"]
        nested = "inputAudioTranscription" in s["generationConfig"]
        layout = LAYOUT_GENERATION_CONFIG if nested else LAYOUT_SETUP
        if self.reject_layout == layout:
            await ws.close(
                1007,
                'Invalid JSON payload received. Unknown name "inputAudioTranscription"',
            )
            return
        await ws.send(json.dumps({"setupComplete": {}}))
        times: list[float] = []
        self.audio_msgs.append(times)
        try:
            async for raw in ws:
                msg = json.loads(raw)
                audio = msg["realtimeInput"]["audio"]
                assert audio["mimeType"] == "audio/pcm;rate=16000"
                pcm = base64.b64decode(audio["data"])
                times.append(time.monotonic())
                n = len(times)
                # Respond immediately with "translated" audio (upsampled) + transcript.
                up = np.repeat(np.frombuffer(pcm, np.int16), 3)[
                    : len(pcm) // 2 * 3 // 2
                ].tobytes()
                await ws.send(
                    json.dumps(
                        {
                            "serverContent": {
                                "modelTurn": {
                                    "parts": [
                                        {
                                            "inlineData": {
                                                "mimeType": "audio/pcm;rate=24000",
                                                "data": base64.b64encode(up).decode(),
                                            }
                                        }
                                    ]
                                },
                                "outputTranscription": {
                                    "text": "cześć ",
                                    "languageCode": "pl",
                                },
                                "inputTranscription": {
                                    "text": "hola ",
                                    "languageCode": "es-AR",
                                },
                            }
                        }
                    )
                )
                if self.goaway_after and conn == 1 and n == self.goaway_after:
                    await ws.send(json.dumps({"goAway": {"timeLeft": "2s"}}))
                if self.drop_after and conn == 1 and n == self.drop_after:
                    await ws.close(1011, "internal error")
                    return
        except Exception:
            return

    async def __aenter__(self):
        self.server = await serve(self.handler, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        with contextlib.suppress(Exception):
            await self.server.wait_closed()


def provider(fake: FakeGemini, **kw) -> GeminiProvider:
    return GeminiProvider(
        api_key="test-key",
        model="gemini-3.5-live-translate-preview",
        url=fake.url,
        layout_state=_LayoutState(),
        **kw,
    )


# --- pure helpers ---------------------------------------------------------------


def test_setup_payload_default_layout_matches_contract():
    p = build_setup_payload(
        model="gemini-3.5-live-translate-preview",
        target_lang="pl",
        echo_target=False,
        layout=LAYOUT_SETUP,
    )
    assert p == {
        "setup": {
            "model": "models/gemini-3.5-live-translate-preview",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "translationConfig": {
                    "targetLanguageCode": "pl",
                    "echoTargetLanguage": False,
                },
            },
            "realtimeInputConfig": {"automaticActivityDetection": {"disabled": False}},
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
        }
    }


def test_setup_payload_nested_layout():
    p = build_setup_payload(
        model="m", target_lang="es", echo_target=True, layout=LAYOUT_GENERATION_CONFIG
    )
    gc = p["setup"]["generationConfig"]
    assert gc["inputAudioTranscription"] == {} and gc["outputAudioTranscription"] == {}
    assert gc["translationConfig"] == {
        "targetLanguageCode": "es",
        "echoTargetLanguage": True,
    }
    assert "inputAudioTranscription" not in p["setup"]


def test_parse_server_message_audio_transcripts_turn_and_goaway():
    pcm = b"\x01\x00" * 240
    events = parse_server_message(
        {
            "serverContent": {
                "modelTurn": {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": "audio/pcm;rate=24000",
                                "data": base64.b64encode(pcm).decode(),
                            }
                        }
                    ]
                },
                "inputTranscription": {"text": "hola", "languageCode": "es"},
                "outputTranscription": {"text": "cześć", "languageCode": "pl"},
                "turnComplete": True,
            },
            "goAway": {"timeLeft": "10s"},
        }
    )
    kinds = [type(e) for e in events]
    assert kinds == [GoAway, AudioOut, TranscriptOut, TranscriptOut, SegmentEnd]
    assert events[0].time_left_sec == 10.0
    assert events[1].pcm == pcm and events[1].sample_rate == 24000
    assert events[2].kind == "input" and events[2].lang == "es"
    assert events[3].kind == "output" and events[3].text == "cześć"


def test_gemini_does_not_support_regional_targets():
    p = GeminiProvider(api_key="k", model="m")
    assert p.supports("pl") and p.supports("es") and p.supports("en")
    assert not p.supports("es-AR")


# --- against the fake server ------------------------------------------------------------


async def test_connect_sends_exact_setup_and_uses_header_auth():
    async with FakeGemini() as fake:
        stream = await provider(fake).connect(target_lang="pl", echo_target=False)
        await stream.aclose()
    assert fake.setups[0] == build_setup_payload(
        model="gemini-3.5-live-translate-preview",
        target_lang="pl",
        echo_target=False,
        layout=LAYOUT_SETUP,
    )
    hdrs = {k.lower(): v for k, v in fake.headers[0].items()}
    assert hdrs["x-goog-api-key"] == "test-key"
    assert "key=" not in fake.url


async def test_layout_fallback_is_automatic_and_remembered():
    async with FakeGemini(reject_layout=LAYOUT_SETUP) as fake:
        p = provider(fake)
        stream = await p.connect(target_lang="es", echo_target=False)
        await stream.aclose()
        assert p._layout.current == LAYOUT_GENERATION_CONFIG and p._layout.confirmed
        stream2 = await p.connect(target_lang="es", echo_target=False)
        await stream2.aclose()
    assert (
        fake.connections == 3
    )  # rejected, fallback, then directly the remembered layout


async def test_both_layouts_rejected_is_fatal():
    class RejectAll(FakeGemini):
        async def handler(self, ws):
            self.connections += 1
            await ws.recv()
            await ws.close(1007, "Unknown name")

    async with RejectAll() as fake:
        with pytest.raises(SetupRejectedError) as info:
            await provider(fake).connect(target_lang="pl", echo_target=False)
    assert info.value.retryable is False


async def test_audio_is_forwarded_chunk_by_chunk_while_input_still_streams():
    async with FakeGemini() as fake:
        stream = await provider(fake).connect(target_lang="pl", echo_target=False)
        first_out: list[float] = []

        async def reader():
            async for ev in stream.events():
                if isinstance(ev, AudioOut):
                    first_out.append(time.monotonic())
                    return

        task = asyncio.create_task(reader())
        chunk = speech_like(0.1, rate=16000).tobytes()
        sent_last = 0.0
        for _ in range(30):  # 3 s of input in 100 ms chunks
            await stream.send_audio(chunk)
            sent_last = time.monotonic()
            await asyncio.sleep(0.1)
        await asyncio.wait_for(task, 2)
        await stream.aclose()
    assert first_out and first_out[0] < sent_last - 2.0
    times = fake.audio_msgs[0]
    assert len(times) == 30
    gaps = np.diff(times)
    assert gaps.max() < 0.35  # no batching on our side


async def test_session_end_to_end_with_fake_gemini_and_goaway_rotation():
    async with FakeGemini(goaway_after_msgs=10) as fake:
        settings = fast(input_gate=False)
        inp = SpeakerInput(
            identity="spk",
            frames=paced_then_silence(frames_of(speech_like(3.0, seed=4))),
            settings=settings,
            resampler_factory=simple_resampler_factory,
        )
        io = FakeRoomIO()
        session = TranslationSession(
            key=SessionKey("g", "grp", "spk", "pl"),
            speaker_input=inp,
            providers=[provider(fake)],
            echo_target=False,
            room_io=io,
            settings=settings,
            publish_source=True,
            resampler_factory=simple_resampler_factory,
        )
        await session.start()
        inp.start()
        assert await wait_for(lambda: session.rotations == 1, timeout=6)
        assert await wait_for(
            lambda: len(fake.audio_msgs) == 2 and len(fake.audio_msgs[1]) > 5, timeout=4
        )
        _, sink = next(iter(io.tracks.values()))
        assert any(rms(p) > 300 for _, p in sink.written)
        assert any(
            c["kind"] == "source" and c["source_lang"] == "es-AR" for c in io.captions
        )
        assert any(
            c["kind"] == "translation" and c["target_lang"] == "pl" for c in io.captions
        )
        await session.aclose()
        await inp.aclose()


async def test_session_reconnects_after_abrupt_close():
    async with FakeGemini(drop_after_msgs=8) as fake:
        settings = fast(input_gate=False)
        inp = SpeakerInput(
            identity="spk",
            frames=paced_then_silence(frames_of(speech_like(3.0, seed=5))),
            settings=settings,
            resampler_factory=simple_resampler_factory,
        )
        io = FakeRoomIO()
        session = TranslationSession(
            key=SessionKey("g", "grp", "spk", "pl"),
            speaker_input=inp,
            providers=[provider(fake)],
            echo_target=False,
            room_io=io,
            settings=settings,
            resampler_factory=simple_resampler_factory,
        )
        await session.start()
        inp.start()
        assert await wait_for(
            lambda: fake.connections >= 2 and len(fake.audio_msgs[-1]) > 3, timeout=6
        )
        states = [e["state"] for e in io.events if e.get("t") == "session"]
        assert "reconnecting" in states
        await session.aclose()
        await inp.aclose()

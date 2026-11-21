"""OpenAI gpt-realtime-translate wire protocol against a fake WebSocket server."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import time

import pytest
from helpers import speech_like
from websockets.asyncio.server import serve

from providers.base import AudioOut, ProviderError, StreamClosed, TranscriptOut
from providers.openai_translate import (
    OpenAITranslateProvider,
    build_session_update,
    parse_server_event,
)


class FakeOpenAI:
    def __init__(self, *, error_on_connect: str | None = None):
        self.error_on_connect = error_on_connect
        self.received: list[dict] = []
        self.headers: list[dict] = []
        self.paths: list[str] = []
        self.server = None
        self.base = ""

    async def handler(self, ws):
        self.headers.append(dict(ws.request.headers))
        self.paths.append(ws.request.path)
        if self.error_on_connect:
            await ws.send(
                json.dumps(
                    {
                        "type": "error",
                        "error": {"code": self.error_on_connect, "message": "nope"},
                    }
                )
            )
            await ws.close()
            return
        await ws.send(json.dumps({"type": "session.created", "session": {}}))
        try:
            async for raw in ws:
                msg = json.loads(raw)
                self.received.append(msg)
                if msg["type"] == "session.input_audio_buffer.append":
                    pcm = base64.b64decode(msg["audio"])
                    await ws.send(
                        json.dumps(
                            {
                                "type": "session.output_audio.delta",
                                "delta": base64.b64encode(pcm).decode(),
                            }
                        )
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "type": "session.output_transcript.delta",
                                "delta": "hola ",
                            }
                        )
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "type": "session.input_transcript.delta",
                                "delta": "cześć ",
                            }
                        )
                    )
                elif msg["type"] == "session.close":
                    await ws.send(json.dumps({"type": "session.closed"}))
                    return
        except Exception:
            return

    async def __aenter__(self):
        self.server = await serve(self.handler, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.base = f"ws://127.0.0.1:{port}/v1/realtime/translations"
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        with contextlib.suppress(Exception):
            await self.server.wait_closed()


def test_session_update_shape():
    assert build_session_update("es") == {
        "type": "session.update",
        "session": {
            "audio": {
                "input": {
                    "transcription": {"model": "gpt-realtime-whisper"},
                    "noise_reduction": {"type": "near_field"},
                },
                "output": {"language": "es"},
            }
        },
    }


def test_openai_cannot_target_polish_and_never_gates_input():
    p = OpenAITranslateProvider(api_key="k")
    assert not p.supports("pl")
    assert p.supports("es") and p.supports("en")
    assert p.capabilities.allows_input_gating is False
    assert p.input_sample_rate == 24000


def test_parse_events():
    pcm = b"\x02\x00" * 10
    assert parse_server_event(
        {"type": "session.output_audio.delta", "delta": base64.b64encode(pcm).decode()}
    ) == [AudioOut(pcm, 24000)]
    assert parse_server_event(
        {"type": "session.output_transcript.delta", "delta": "x"}
    ) == [TranscriptOut("output", "x")]
    assert parse_server_event(
        {"type": "session.input_transcript.delta", "delta": "y"}
    ) == [TranscriptOut("input", "y")]
    assert parse_server_event({"type": "session.closed"}) == [
        StreamClosed("session.closed")
    ]
    err = parse_server_event(
        {"type": "error", "error": {"code": "invalid_api_key", "message": "bad"}}
    )[0]
    assert err.retryable is False


async def test_connect_configures_session_and_streams_continuously():
    async with FakeOpenAI() as fake:
        p = OpenAITranslateProvider(api_key="sk-test", base_url=fake.base)
        stream = await p.connect(target_lang="es", echo_target=False)
        outputs: list[float] = []

        async def reader():
            async for ev in stream.events():
                if isinstance(ev, AudioOut):
                    outputs.append(time.monotonic())

        task = asyncio.create_task(reader())
        chunk = speech_like(0.1, rate=24000).tobytes()
        last = 0.0
        for _ in range(10):
            await stream.send_audio(chunk)
            last = time.monotonic()
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)
        await stream.aclose()
        await asyncio.wait_for(task, 2)
    assert fake.paths[0] == "/v1/realtime/translations?model=gpt-realtime-translate"
    hdrs = {k.lower(): v for k, v in fake.headers[0].items()}
    assert hdrs["authorization"] == "Bearer sk-test"
    assert fake.received[0] == build_session_update("es")
    appends = [
        m for m in fake.received if m["type"] == "session.input_audio_buffer.append"
    ]
    assert len(appends) == 10
    assert fake.received[-1] == {"type": "session.close"}
    assert outputs and outputs[0] < last


async def test_connect_error_is_reported_with_retryability():
    async with FakeOpenAI(error_on_connect="invalid_api_key") as fake:
        p = OpenAITranslateProvider(api_key="bad", base_url=fake.base)
        with pytest.raises(ProviderError) as info:
            await p.connect(target_lang="en", echo_target=False)
    assert info.value.retryable is False

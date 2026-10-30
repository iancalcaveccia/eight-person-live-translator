"""OpenAI gpt-realtime-translate provider (dedicated translation WebSocket).

Docs: https://developers.openai.com/api/docs/guides/realtime-translation

This is the translation endpoint `/v1/realtime/translations`, NOT the
voice-assistant `/v1/realtime` endpoint; there is no `response.create` and no
turn handling. Audio is PCM16 mono 24 kHz in both directions and must be sent
continuously (including silence), so input gating is disabled for this
provider. Output languages (13) do NOT include Polish; the router never asks
this provider for a `pl` target. Custom voice selection is not supported.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from config import OPENAI_INPUT_SAMPLE_RATE, OPENAI_OUTPUT_SAMPLE_RATE
from providers.base import (
    OPENAI_TARGETS,
    AudioOut,
    ProviderCapabilities,
    ProviderError,
    ProviderEvent,
    ProviderStream,
    StreamClosed,
    StreamError,
    TranscriptOut,
    TranslationProvider,
)

logger = logging.getLogger("translator.openai")

OPENAI_WS_BASE = "wss://api.openai.com/v1/realtime/translations"

_FATAL_CODES = {"invalid_api_key", "insufficient_quota", "model_not_found"}


def build_session_update(target_lang: str) -> dict[str, Any]:
    return {
        "type": "session.update",
        "session": {
            "audio": {
                "input": {
                    "transcription": {"model": "gpt-realtime-whisper"},
                    "noise_reduction": {"type": "near_field"},
                },
                "output": {"language": target_lang},
            }
        },
    }


def build_append_message(pcm: bytes) -> str:
    return json.dumps(
        {
            "type": "session.input_audio_buffer.append",
            "audio": base64.b64encode(pcm).decode("ascii"),
        }
    )


def parse_server_event(msg: dict[str, Any]) -> list[ProviderEvent]:
    t = msg.get("type", "")
    if t == "session.output_audio.delta":
        delta = msg.get("delta")
        if not delta:
            return []
        rate = int(msg.get("sample_rate") or OPENAI_OUTPUT_SAMPLE_RATE)
        return [AudioOut(pcm=base64.b64decode(delta), sample_rate=rate)]
    if t == "session.output_transcript.delta":
        delta = msg.get("delta") or ""
        return [TranscriptOut(kind="output", text=delta)] if delta else []
    if t == "session.input_transcript.delta":
        delta = msg.get("delta") or ""
        lang = msg.get("language") or None
        return [TranscriptOut(kind="input", text=delta, lang=lang)] if delta else []
    if t == "error":
        err = msg.get("error") or {}
        code = str(err.get("code") or "")
        return [
            StreamError(
                message=str(err.get("message") or "openai error")[:300],
                retryable=code not in _FATAL_CODES,
                code=code,
            )
        ]
    if t == "session.closed":
        return [StreamClosed(reason="session.closed")]
    return []


class OpenAIStream(ProviderStream):
    def __init__(self, ws: Any, close_deadline_sec: float = 5.0) -> None:
        self._ws = ws
        self._closed = False
        self._close_deadline = close_deadline_sec
        self._session_closed = asyncio.Event()
        self._reading = False

    async def send_audio(self, pcm: bytes) -> None:
        if self._closed:
            raise ProviderError("stream closed")
        try:
            await self._ws.send(build_append_message(pcm))
        except ConnectionClosed as exc:
            self._closed = True
            raise ProviderError("openai socket closed") from exc

    async def events(self) -> AsyncIterator[ProviderEvent]:
        # Only a real close (session.closed or socket close) marks the stream
        # closed; a consumer that stops early must not skip the graceful
        # session.close in aclose().
        self._reading = True
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                for ev in parse_server_event(msg):
                    if isinstance(ev, StreamClosed):
                        self._mark_closed()
                        yield ev
                        return
                    yield ev
        except ConnectionClosed as exc:
            self._mark_closed()
            rcvd = getattr(exc, "rcvd", None)
            code = rcvd.code if rcvd else None
            if code in (1000, 1001):
                yield StreamClosed(reason="closed")
            else:
                yield StreamError(
                    message=f"openai closed {code}", retryable=True, code=str(code)
                )
                yield StreamClosed(reason=f"error {code}")
            return
        finally:
            self._reading = False
        self._mark_closed()
        yield StreamClosed(reason="server closed")

    def _mark_closed(self) -> None:
        self._closed = True
        self._session_closed.set()

    async def aclose(self) -> None:
        if self._closed:
            with contextlib.suppress(Exception):
                await self._ws.close()
            return
        self._closed = True
        # Graceful: ask the server to flush and close, wait briefly for
        # session.closed, then drop the socket. If nobody is consuming
        # events() any more, drain the socket ourselves until the deadline.
        with contextlib.suppress(Exception):
            await self._ws.send(json.dumps({"type": "session.close"}))
            if self._reading:
                await asyncio.wait_for(
                    self._session_closed.wait(), timeout=self._close_deadline
                )
            else:
                await asyncio.wait_for(
                    self._drain_until_closed(), timeout=self._close_deadline
                )
        with contextlib.suppress(Exception):
            await self._ws.close()

    async def _drain_until_closed(self) -> None:
        while True:
            raw = await self._ws.recv()
            with contextlib.suppress(Exception):
                if json.loads(raw).get("type") == "session.closed":
                    return


class OpenAITranslateProvider(TranslationProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-realtime-translate",
        chunk_ms: int = 100,
        base_url: str = OPENAI_WS_BASE,
        connect_timeout_sec: float = 10.0,
        connector: Callable[..., Any] | None = None,
        safety_identifier: str | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required for the openai provider")
        self._api_key = api_key
        self._model = model
        self._url = f"{base_url}?model={model}"
        self._timeout = connect_timeout_sec
        self._connector = connector or websockets.connect
        self._safety_identifier = safety_identifier
        self.capabilities = ProviderCapabilities(
            name="openai",
            input_sample_rate=OPENAI_INPUT_SAMPLE_RATE,
            output_sample_rate=OPENAI_OUTPUT_SAMPLE_RATE,
            chunk_ms=chunk_ms,
            allows_input_gating=False,
            supported_targets=OPENAI_TARGETS,
        )

    async def connect(self, *, target_lang: str, echo_target: bool) -> ProviderStream:
        # echo_target has no equivalent on this API; the model may stay silent
        # for speech already in the output language.
        if not self.supports(target_lang):
            raise ProviderError(
                f"openai does not support target {target_lang}", retryable=False
            )
        headers = {"Authorization": f"Bearer {self._api_key}"}
        if self._safety_identifier:
            headers["OpenAI-Safety-Identifier"] = self._safety_identifier
        try:
            ws = await asyncio.wait_for(
                self._connector(self._url, additional_headers=headers, max_size=2**22),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError as exc:
            raise ProviderError("openai connect timeout") from exc
        except Exception as exc:
            raise ProviderError(f"openai connect failed: {type(exc).__name__}") from exc

        try:
            await asyncio.wait_for(self._await_created(ws), timeout=self._timeout)
            await ws.send(json.dumps(build_session_update(target_lang)))
        except asyncio.TimeoutError as exc:
            with contextlib.suppress(Exception):
                await ws.close()
            raise ProviderError("openai session.created timeout") from exc
        except ConnectionClosed as exc:
            raise ProviderError("openai closed during setup") from exc
        logger.info("openai translation session ready target=%s", target_lang)
        return OpenAIStream(ws)

    @staticmethod
    async def _await_created(ws: Any) -> None:
        while True:
            raw = await ws.recv()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            t = msg.get("type")
            if t == "session.created":
                return
            if t == "error":
                err = msg.get("error") or {}
                code = str(err.get("code") or "")
                raise ProviderError(
                    str(err.get("message") or "openai error")[:200],
                    retryable=code not in _FATAL_CODES,
                    code=code,
                )

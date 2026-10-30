"""Gemini 3.5 Live Translate provider (raw v1beta BidiGenerateContent WebSocket).

Docs: https://ai.google.dev/gemini-api/docs/live-api/live-translate

- Setup uses `generationConfig.translationConfig` with `targetLanguageCode`
  and `echoTargetLanguage` (the public-launch names; the pinned google-genai
  2.5 SDK still emits the EAP-era `streamTranslationConfig`, which is why we
  speak raw JSON here).
- Transcription flags: the current docs nest `inputAudioTranscription` /
  `outputAudioTranscription` under `generationConfig`; the upstream example
  and the SDK put them at `setup` level. We default to `setup` level (known to
  work upstream) and fall back ONCE to the nested layout if the server rejects
  the setup before `setupComplete`. The working layout is remembered for the
  whole process.
- Authentication uses the `x-goog-api-key` header (same as the SDK) so the key
  never appears in a URL or a log line.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from config import GEMINI_INPUT_SAMPLE_RATE, GEMINI_OUTPUT_SAMPLE_RATE
from providers.base import (
    GEMINI_TARGETS,
    AudioOut,
    GoAway,
    ProviderCapabilities,
    ProviderError,
    ProviderEvent,
    ProviderStream,
    SegmentEnd,
    SetupRejectedError,
    StreamClosed,
    StreamError,
    TranscriptOut,
    TranslationProvider,
)

logger = logging.getLogger("translator.gemini")

GEMINI_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)

LAYOUT_SETUP = "setup"
LAYOUT_GENERATION_CONFIG = "generationConfig"
_LAYOUTS = (LAYOUT_SETUP, LAYOUT_GENERATION_CONFIG)


class _LayoutState:
    """Process-wide memory of which setup layout the server accepted."""

    def __init__(self) -> None:
        self.current = LAYOUT_SETUP
        self.confirmed = False
        self.rejected: set[str] = set()

    def reset(self) -> None:
        self.__init__()


LAYOUT_STATE = _LayoutState()

_REJECT_HINTS = (
    "unknown name",
    "invalid json payload",
    "cannot find field",
    "invalid argument",
    "invalid_argument",
)


def build_setup_payload(
    *, model: str, target_lang: str, echo_target: bool, layout: str
) -> dict[str, Any]:
    generation_config: dict[str, Any] = {
        "responseModalities": ["AUDIO"],
        "translationConfig": {
            "targetLanguageCode": target_lang,
            "echoTargetLanguage": echo_target,
        },
    }
    setup: dict[str, Any] = {
        "model": f"models/{model}",
        "generationConfig": generation_config,
        "realtimeInputConfig": {"automaticActivityDetection": {"disabled": False}},
    }
    if layout == LAYOUT_GENERATION_CONFIG:
        generation_config["inputAudioTranscription"] = {}
        generation_config["outputAudioTranscription"] = {}
    else:
        setup["inputAudioTranscription"] = {}
        setup["outputAudioTranscription"] = {}
    return {"setup": setup}


def build_audio_message(pcm: bytes) -> str:
    return json.dumps(
        {
            "realtimeInput": {
                "audio": {
                    "mimeType": f"audio/pcm;rate={GEMINI_INPUT_SAMPLE_RATE}",
                    "data": base64.b64encode(pcm).decode("ascii"),
                }
            }
        }
    )


_RATE_RE = re.compile(r"rate=(\d+)")


def _parse_duration(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = re.match(r"^\s*([0-9.]+)\s*s\s*$", value)
        if m:
            return float(m.group(1))
    return None


def parse_server_message(msg: dict[str, Any]) -> list[ProviderEvent]:
    """Map one decoded server message to provider events (pure, unit-tested)."""
    events: list[ProviderEvent] = []

    if "goAway" in msg:
        ga = msg.get("goAway") or {}
        events.append(GoAway(time_left_sec=_parse_duration(ga.get("timeLeft"))))

    err = msg.get("error")
    if err:
        message = err.get("message", "") if isinstance(err, dict) else str(err)
        events.append(StreamError(message=message[:300], retryable=True))

    sc = msg.get("serverContent")
    if not sc:
        return events

    model_turn = sc.get("modelTurn")
    if model_turn:
        for part in model_turn.get("parts") or []:
            inline = part.get("inlineData") or {}
            data = inline.get("data")
            if not data:
                continue
            rate = GEMINI_OUTPUT_SAMPLE_RATE
            m = _RATE_RE.search(inline.get("mimeType") or "")
            if m:
                rate = int(m.group(1))
            events.append(AudioOut(pcm=base64.b64decode(data), sample_rate=rate))

    for key, kind in (
        ("inputTranscription", "input"),
        ("outputTranscription", "output"),
    ):
        tr = sc.get(key)
        if tr and tr.get("text"):
            events.append(
                TranscriptOut(
                    kind=kind,  # type: ignore[arg-type]
                    text=tr["text"],
                    lang=tr.get("languageCode") or None,
                )
            )

    if sc.get("turnComplete"):
        events.append(SegmentEnd())
    return events


def _looks_like_setup_rejection(code: int | None, reason: str) -> bool:
    if code == 1007:
        return True
    lowered = (reason or "").lower()
    return any(h in lowered for h in _REJECT_HINTS)


def _is_fatal(code: int | None, reason: str) -> bool:
    lowered = (reason or "").lower()
    if code == 1008 and "api key" in lowered:
        return True
    return "api key not valid" in lowered or (
        "permission" in lowered and "denied" in lowered
    )


Connector = Callable[..., Any]


class GeminiStream(ProviderStream):
    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._closed = False

    async def send_audio(self, pcm: bytes) -> None:
        if self._closed:
            raise ProviderError("stream closed")
        try:
            await self._ws.send(build_audio_message(pcm))
        except ConnectionClosed as exc:
            self._closed = True
            raise ProviderError(f"gemini socket closed: {_close_text(exc)}") from exc

    async def events(self) -> AsyncIterator[ProviderEvent]:
        # Only an actual socket close marks the stream closed; a consumer that
        # stops iterating early must not break send_audio().
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                for ev in parse_server_message(msg):
                    yield ev
        except ConnectionClosed as exc:
            self._closed = True
            code, reason = _close_parts(exc)
            if code in (1000, 1001):
                yield StreamClosed(reason=reason or "closed")
            else:
                yield StreamError(
                    message=f"gemini closed {code}: {reason[:200]}",
                    retryable=not _is_fatal(code, reason),
                    code=str(code),
                )
                yield StreamClosed(reason=f"error {code}")
            return
        self._closed = True
        yield StreamClosed(reason="server closed")

    async def aclose(self) -> None:
        self._closed = True
        with contextlib.suppress(Exception):
            await self._ws.close()


def _close_parts(exc: ConnectionClosed) -> tuple[int | None, str]:
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None:
        return rcvd.code, rcvd.reason or ""
    return None, str(exc)


def _close_text(exc: ConnectionClosed) -> str:
    code, reason = _close_parts(exc)
    return f"{code} {reason[:120]}"


class GeminiProvider(TranslationProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        chunk_ms: int = 100,
        url: str = GEMINI_WS_URL,
        connect_timeout_sec: float = 10.0,
        connector: Connector | None = None,
        layout_state: _LayoutState | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is required for the gemini provider")
        self._api_key = api_key
        self._model = model
        self._url = url
        self._timeout = connect_timeout_sec
        self._connector = connector or websockets.connect
        self._layout = layout_state or LAYOUT_STATE
        self.capabilities = ProviderCapabilities(
            name="gemini",
            input_sample_rate=GEMINI_INPUT_SAMPLE_RATE,
            output_sample_rate=GEMINI_OUTPUT_SAMPLE_RATE,
            chunk_ms=chunk_ms,
            allows_input_gating=True,
            supported_targets=GEMINI_TARGETS,
        )

    async def connect(self, *, target_lang: str, echo_target: bool) -> ProviderStream:
        if not self.supports(target_lang):
            raise ProviderError(
                f"gemini does not support target {target_lang}", retryable=False
            )
        layout = self._layout.current
        try:
            return await self._connect_with_layout(target_lang, echo_target, layout)
        except SetupRejectedError as exc:
            self._layout.rejected.add(layout)
            alternatives = [x for x in _LAYOUTS if x not in self._layout.rejected]
            if self._layout.confirmed or not alternatives:
                raise SetupRejectedError(str(exc), retryable=False) from exc
            alt = alternatives[0]
            logger.warning(
                "gemini rejected setup layout %r (%s); retrying with %r",
                layout,
                exc,
                alt,
            )
            self._layout.current = alt
            try:
                return await self._connect_with_layout(target_lang, echo_target, alt)
            except SetupRejectedError as exc2:
                self._layout.rejected.add(alt)
                raise SetupRejectedError(
                    f"both setup layouts rejected: {exc2}", retryable=False
                ) from exc2

    async def _connect_with_layout(
        self, target_lang: str, echo_target: bool, layout: str
    ) -> ProviderStream:
        payload = build_setup_payload(
            model=self._model,
            target_lang=target_lang,
            echo_target=echo_target,
            layout=layout,
        )
        try:
            ws = await asyncio.wait_for(
                self._connector(
                    self._url,
                    additional_headers={"x-goog-api-key": self._api_key},
                    max_size=2**22,
                    ping_interval=20,
                    ping_timeout=20,
                ),
                timeout=self._timeout,
            )
        except asyncio.TimeoutError as exc:
            raise ProviderError("gemini connect timeout") from exc
        except ProviderError:
            raise
        except Exception as exc:  # network / handshake errors
            raise ProviderError(f"gemini connect failed: {type(exc).__name__}") from exc

        try:
            await ws.send(json.dumps(payload))
            await asyncio.wait_for(
                self._await_setup_complete(ws), timeout=self._timeout
            )
        except SetupRejectedError:
            with contextlib.suppress(Exception):
                await ws.close()
            raise
        except asyncio.TimeoutError as exc:
            with contextlib.suppress(Exception):
                await ws.close()
            raise ProviderError("gemini setupComplete timeout") from exc
        except ConnectionClosed as exc:
            code, reason = _close_parts(exc)
            if _looks_like_setup_rejection(code, reason):
                raise SetupRejectedError(
                    f"setup rejected {code}: {reason[:200]}"
                ) from exc
            raise ProviderError(
                f"gemini closed during setup {code}: {reason[:200]}",
                retryable=not _is_fatal(code, reason),
                code=str(code),
            ) from exc

        self._layout.confirmed = True
        self._layout.current = layout
        logger.info("gemini setup complete target=%s layout=%s", target_lang, layout)
        return GeminiStream(ws)

    @staticmethod
    async def _await_setup_complete(ws: Any) -> None:
        while True:
            raw = await ws.recv()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if msg.get("setupComplete") is not None:
                return
            err = msg.get("error")
            if err:
                message = err.get("message", "") if isinstance(err, dict) else str(err)
                if _looks_like_setup_rejection(None, message):
                    raise SetupRejectedError(message[:200])
                raise ProviderError(message[:200])

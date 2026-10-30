"""Provider abstraction for streaming speech-to-speech translation.

A *provider* knows how to open a *stream*: one continuous translation of one
speaker's audio into one target language. Streams accept PCM16 mono at the
provider's input rate and yield events as soon as the provider emits them —
never batched per utterance.
"""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal


class ProviderError(Exception):
    """Raised by connect() or surfaced as an event when a stream fails."""

    def __init__(self, message: str, *, retryable: bool = True, code: str = "") -> None:
        super().__init__(message)
        self.retryable = retryable
        self.code = code


class SetupRejectedError(ProviderError):
    """The provider rejected the session setup message before accepting it."""


@dataclass(frozen=True)
class AudioOut:
    pcm: bytes  # PCM16 little-endian mono
    sample_rate: int

    @property
    def duration_sec(self) -> float:
        return len(self.pcm) / 2 / self.sample_rate


@dataclass(frozen=True)
class TranscriptOut:
    kind: Literal["input", "output"]
    text: str
    lang: str | None = None


@dataclass(frozen=True)
class SegmentEnd:
    """Provider signalled the end of an utterance (e.g. Gemini turnComplete).
    Used ONLY to segment captions; audio is never gated on it."""


@dataclass(frozen=True)
class GoAway:
    """Provider announced the connection will close soon (rotate now)."""

    time_left_sec: float | None = None


@dataclass(frozen=True)
class StreamError:
    message: str
    retryable: bool = True
    code: str = ""


@dataclass(frozen=True)
class StreamClosed:
    reason: str = ""


ProviderEvent = (
    AudioOut | TranscriptOut | SegmentEnd | GoAway | StreamError | StreamClosed
)


class ProviderStream(abc.ABC):
    """One open translation connection."""

    @abc.abstractmethod
    async def send_audio(self, pcm: bytes) -> None:
        """Send one chunk of PCM16 mono at the provider's input rate."""

    @abc.abstractmethod
    def events(self) -> AsyncIterator[ProviderEvent]:
        """Yield events until the stream closes. Ends with StreamClosed."""

    @abc.abstractmethod
    async def aclose(self) -> None:
        """Close gracefully. Idempotent."""


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    input_sample_rate: int
    output_sample_rate: int
    chunk_ms: int
    allows_input_gating: bool
    supported_targets: frozenset[str]

    def supports(self, target_lang: str) -> bool:
        return target_lang in self.supported_targets


class TranslationProvider(abc.ABC):
    """Factory for streams. Instances are shared across sessions in a job."""

    capabilities: ProviderCapabilities

    @property
    def name(self) -> str:
        return self.capabilities.name

    @property
    def input_sample_rate(self) -> int:
        return self.capabilities.input_sample_rate

    @property
    def output_sample_rate(self) -> int:
        return self.capabilities.output_sample_rate

    @property
    def chunk_ms(self) -> int:
        return self.capabilities.chunk_ms

    def supports(self, target_lang: str) -> bool:
        return self.capabilities.supports(target_lang)

    @abc.abstractmethod
    async def connect(self, *, target_lang: str, echo_target: bool) -> ProviderStream:
        """Open a stream and return once the provider is ready for audio.

        Raises ProviderError (or SetupRejectedError) on failure."""


# Capability table (verified 2026-10-30 against official docs):
# - Gemini 3.5 Live Translate: 70+ targets incl. en, pl, es; no regional
#   Spanish codes; 16 kHz in / 24 kHz out; ~100 ms chunks recommended.
# - OpenAI gpt-realtime-translate: 13 output languages incl. en, es but NOT pl;
#   24 kHz in / out; send audio continuously, including silence.
GEMINI_TARGETS = frozenset({"en", "pl", "es"})
OPENAI_TARGETS = frozenset({"en", "es"})
MOCK_TARGETS = frozenset({"en", "pl", "es"})

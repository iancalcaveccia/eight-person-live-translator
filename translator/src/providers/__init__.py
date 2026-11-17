"""Translation providers and the factory that builds them from Settings."""

from __future__ import annotations

import logging
import os

from config import Settings
from providers.base import TranslationProvider

logger = logging.getLogger("translator.providers")


def gemini_activity_from_env() -> dict[str, object] | None:
    """Gemini speech-detection tuning, only when explicitly configured:
    GEMINI_VAD_START (START_SENSITIVITY_HIGH|LOW), GEMINI_VAD_END
    (END_SENSITIVITY_HIGH|LOW), GEMINI_VAD_SILENCE_MS, GEMINI_VAD_PREFIX_MS."""
    out: dict[str, object] = {}
    start = os.environ.get("GEMINI_VAD_START", "").strip()
    end = os.environ.get("GEMINI_VAD_END", "").strip()
    if start in ("START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"):
        out["startOfSpeechSensitivity"] = start
    if end in ("END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"):
        out["endOfSpeechSensitivity"] = end
    for env, key in (
        ("GEMINI_VAD_SILENCE_MS", "silenceDurationMs"),
        ("GEMINI_VAD_PREFIX_MS", "prefixPaddingMs"),
    ):
        raw = os.environ.get(env, "").strip()
        if raw.isdigit():
            out[key] = int(raw)
    return out or None


def build_providers(settings: Settings) -> dict[str, TranslationProvider]:
    """Instantiate every provider that has credentials (mock is always available
    when explicitly selected). Keys: provider name."""
    providers: dict[str, TranslationProvider] = {}

    if settings.translation_provider == "mock":
        from providers.mock import MockProvider

        providers["mock"] = MockProvider(
            delay_ms=settings.mock_delay_ms, chunk_ms=settings.mock_chunk_ms
        )

    if settings.gemini_api_key:
        from providers.gemini import GeminiProvider

        providers["gemini"] = GeminiProvider(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            chunk_ms=settings.gemini_chunk_ms,
            connect_timeout_sec=settings.connect_timeout_sec,
            activity=gemini_activity_from_env(),
        )

    if settings.openai_api_key:
        from providers.openai_translate import OpenAITranslateProvider

        providers["openai"] = OpenAITranslateProvider(
            api_key=settings.openai_api_key,
            model=settings.openai_translate_model,
            chunk_ms=settings.openai_chunk_ms,
            connect_timeout_sec=settings.connect_timeout_sec,
        )

    return providers


def provider_chain(
    providers: dict[str, TranslationProvider],
    *,
    preferred: str,
    target_lang: str,
    fallback_enabled: bool,
) -> list[TranslationProvider]:
    """Ordered list of providers able to serve `target_lang`.

    The preferred provider comes first when it supports the target (OpenAI
    cannot target Polish, so a `pl` session on an OpenAI-default gathering is
    served by Gemini). Fallbacks follow only when enabled. The mock provider
    never mixes with real providers.
    """
    order: list[str] = [preferred]
    if "mock" not in order:
        order += [n for n in ("gemini", "openai") if n not in order]
    chain = [
        providers[n]
        for n in order
        if n in providers and providers[n].supports(target_lang)
    ]
    if not chain:
        return []
    if not fallback_enabled:
        return chain[:1]
    return chain

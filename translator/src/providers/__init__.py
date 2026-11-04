"""Translation providers and the factory that builds them from Settings."""

from __future__ import annotations

import logging

from config import Settings
from providers.base import TranslationProvider

logger = logging.getLogger("translator.providers")


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

"""Constants and environment-driven settings for the translation worker.

Names shared with the control plane / browser live in
`docs/architecture/CONTRACT.md`; keep them in sync.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# --- Contract constants (CONTRACT.md) ----------------------------------------

AGENT_NAME_DEFAULT = "gemini-translator"
CONTRACT_VERSION = "1"

SUPPORTED_LANGS: frozenset[str] = frozenset({"en", "pl", "es"})
AUTO_LANG = "auto"

ATTR_VERSION = "interp.v"
ATTR_SPEAK_LANG = "speak_lang"
ATTR_LISTEN_LANG = "listen_lang"
ATTR_ES_REGION = "es_region"
ATTR_ROLE = "role"
ATTR_COLOR = "color"
ATTR_GATHERING_ID = "gathering_id"
ATTR_GROUP_ID = "group_id"
ATTR_EPOCH = "epoch"
ATTR_AGENT_STATUS = "interp.status"

TRANSLATION_TRACK_PREFIX = "tx"
COMPARISON_TRACK_PREFIX = "txc"

CAPTIONS_TOPIC = "lk.translation"
EVENTS_TOPIC = "interp.events"
CONTROL_TOPIC = "interp.control"

# --- Audio formats -----------------------------------------------------------

# SpeakerInput reads every mic once at the native Opus rate and resamples per
# provider; see audio.py.
INPUT_CAPTURE_SAMPLE_RATE = 48000
INPUT_FRAME_MS = 10
AUDIO_CHANNELS = 1

# Gemini Live Translate: 16 kHz PCM16 in, 24 kHz PCM16 out (official docs).
GEMINI_INPUT_SAMPLE_RATE = 16000
GEMINI_OUTPUT_SAMPLE_RATE = 24000
# OpenAI gpt-realtime-translate WebSocket: 24 kHz PCM16 in and out.
OPENAI_INPUT_SAMPLE_RATE = 24000
OPENAI_OUTPUT_SAMPLE_RATE = 24000


def _env_str(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, float(default)))


@dataclass(frozen=True)
class Settings:
    """All tunables. Built from the environment by `load_settings()`; tests
    construct it directly with overrides."""

    # Identity / dispatch
    agent_name: str = AGENT_NAME_DEFAULT

    # Providers
    translation_provider: str = "gemini"  # gemini | openai | mock
    provider_fallback: bool = True
    provider_compare: bool = False
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-live-translate-preview"
    openai_api_key: str = ""
    openai_translate_model: str = "gpt-realtime-translate"

    # Control plane
    control_plane_url: str = ""
    internal_api_secret: str = ""

    # Input processing
    input_gate: bool = True
    bleed_guard: bool = True
    gemini_chunk_ms: int = 100  # Google recommends ~100 ms chunks
    openai_chunk_ms: int = 100  # 100-200 ms; OpenAI examples use ~100 ms
    mock_chunk_ms: int = 50
    gate_pre_roll_ms: int = 600
    gate_hangover_ms: int = 2500
    vad_threshold_db: float = 9.0  # speech = energy above adaptive floor by this much
    vad_min_dbfs: float = -55.0  # never treat frames quieter than this as speech
    # Conservative defaults chosen from a synthetic sweep: 0 false flags for
    # independent speech up to 12 dB quieter than a loud neighbour, ~97 % of
    # 15-18 dB leaks detected. See docs/architecture/WORKER.md.
    bleed_corr_threshold: float = 0.9
    bleed_level_diff_db: float = 13.0
    bleed_window_ms: int = 1000
    bleed_max_lag_ms: int = 120
    # Phones deliver their mic streams with different delays (Bluetooth,
    # capture pipeline, jitter buffers). First real two-phone test 2026-11-17:
    # the 120 ms window above missed the leak entirely; offline, a 200 ms
    # offset let ~90 % of it through. Pairs are aligned within this range.
    bleed_max_offset_ms: int = 600
    bleed_persist_evals: int = 3
    # Real-service simulation 2026-11-17 (2 people, ES/PL, reverberant room):
    # the 0.9 rule alone caught only ~70 % of evaluations and every miss let the
    # gate's hangover forward seconds of the neighbour's voice. Hence: a lower
    # correlation when the neighbour is far louder, sticky flags, and an
    # own-voice override. See docs/architecture/WORKER.md.
    bleed_corr_relaxed: float = 0.7
    bleed_bounded_ratio: float = 0.95
    bleed_bound_margin_db: float = 14.0
    bleed_release_evals: int = 6
    bleed_own_voice_margin_db: float = 10.0
    bleed_own_voice_rise_db: float = 10.0
    bleed_own_voice_hold_ms: int = 1500
    bleed_own_voice_persist_ms: int = 80
    # Same words on two mics (crosstalk.py). Second real session 2026-11-17:
    # the loudness guard above caught 0 s on real phones while the provider kept
    # transcribing the other person; their words are the robust signal.
    crosstalk_guard: bool = True
    crosstalk_window_sec: float = 6.0
    crosstalk_min_words: int = 3
    crosstalk_min_share: float = 0.3
    crosstalk_hold_sec: float = 4.0
    crosstalk_level_margin_db: float = 6.0

    # Output / backlog
    output_queue_ms: int = 30000
    backlog_soft_ms: int = 2500
    backlog_hard_ms: int = 6000
    silence_trim_keep_ms: int = 150

    # Session lifecycle
    session_grace_sec: float = 10.0
    reconnect_backoff_sec: tuple[float, ...] = (
        0.0,
        0.5,
        1.0,
        2.0,
        4.0,
        8.0,
        15.0,
        30.0,
    )
    reconnect_replay_ms: int = 2000
    # Gemini closes a stream after 120 s without audio (measured 2026-11-17:
    # "1008 Session closed due to client inactivity"). The input gate withholds
    # silence, so send one silent chunk after this many seconds without input.
    # 0 disables. ~0.3 % of a quiet speaker's time is sent (and billed).
    stream_keepalive_sec: float = 30.0
    # Give each provider stream a fresh memory this often, at a pause, by
    # opening the next stream before closing the old one (no gap). Owner's
    # 30-min session 2026-11-17: fine at first, "confused, saying odd things"
    # later; a stream otherwise keeps everything it heard until the provider
    # cuts it (~10 min), possibly mid-sentence. 0 disables.
    stream_refresh_sec: float = 300.0
    # Field reports (2026): a Live Translate stream can stay open but go silent
    # for 8 to 51 s. If the provider keeps transcribing foreign speech and nothing
    # comes back for this long, switch to a fresh stream. 0 disables.
    stall_rotate_sec: float = 8.0
    # Names card sent with every new Gemini stream (who speaks, the names at
    # the table). Real-Gemini run 2026-11-18, 16 fresh streams each: the
    # speaker's name came out exactly right 16/16 with it, 2/16 without
    # ("Gianluca", "Ian Luka"); never voiced; other facts unchanged.
    context_card: bool = True
    provider_failures_before_fallback: int = 3
    connect_timeout_sec: float = 10.0
    rotation_drain_sec: float = 3.0
    delayed_no_output_sec: float = 6.0
    caption_segment_gap_sec: float = 1.5

    # Router
    reconcile_debounce_sec: float = 0.25
    idle_shutdown_sec: float = 30.0
    stats_interval_sec: float = 10.0

    # Admission
    admission_debounce_sec: float = 0.3
    admission_reverify_sec: float = 20.0
    admission_cache_sec: float = 60.0
    admission_fail_closed_sec: float = 30.0
    http_timeout_sec: float = 5.0

    # Metering
    usage_interval_sec: float = 15.0
    standalone_max_spend_usd: float = 5.0
    gemini_input_usd_per_min: float = 0.0053
    gemini_output_usd_per_min: float = 0.0315
    openai_usd_per_min: float = 0.034

    # Mock provider
    mock_delay_ms: int = 1200

    extra: dict[str, str] = field(default_factory=dict)

    @property
    def standalone(self) -> bool:
        """True when no control plane is configured (local dev only)."""
        return not self.control_plane_url


def load_settings() -> Settings:
    """Build Settings from environment variables (names from CONTRACT.md §8)."""
    provider = _env_str("TRANSLATION_PROVIDER", "gemini").lower() or "gemini"
    if provider not in {"gemini", "openai", "mock"}:
        provider = "gemini"
    return Settings(
        agent_name=_env_str("TRANSLATOR_AGENT_NAME", AGENT_NAME_DEFAULT)
        or AGENT_NAME_DEFAULT,
        translation_provider=provider,
        provider_fallback=_env_bool("PROVIDER_FALLBACK", True),
        provider_compare=_env_bool("PROVIDER_COMPARE", False),
        gemini_api_key=_env_str("GEMINI_API_KEY"),
        gemini_model=_env_str("GEMINI_MODEL", "gemini-3.5-live-translate-preview")
        or "gemini-3.5-live-translate-preview",
        openai_api_key=_env_str("OPENAI_API_KEY"),
        openai_translate_model=_env_str(
            "OPENAI_TRANSLATE_MODEL", "gpt-realtime-translate"
        )
        or "gpt-realtime-translate",
        control_plane_url=_env_str("CONTROL_PLANE_URL").rstrip("/"),
        internal_api_secret=_env_str("INTERNAL_API_SECRET"),
        input_gate=_env_bool("INPUT_GATE", True),
        bleed_guard=_env_bool("BLEED_GUARD", True),
        bleed_max_offset_ms=_env_int("BLEED_MAX_OFFSET_MS", 600),
        crosstalk_guard=_env_bool("CROSSTALK_GUARD", True),
        crosstalk_min_words=_env_int("CROSSTALK_MIN_WORDS", 3),
        crosstalk_hold_sec=_env_float("CROSSTALK_HOLD_SEC", 4.0),
        crosstalk_level_margin_db=_env_float("CROSSTALK_LEVEL_MARGIN_DB", 6.0),
        gemini_chunk_ms=_env_int("GEMINI_CHUNK_MS", 100),
        openai_chunk_ms=_env_int("OPENAI_CHUNK_MS", 100),
        gate_pre_roll_ms=_env_int("GATE_PRE_ROLL_MS", 600),
        gate_hangover_ms=_env_int("GATE_HANGOVER_MS", 2500),
        backlog_soft_ms=_env_int("BACKLOG_SOFT_MS", 2500),
        backlog_hard_ms=_env_int("BACKLOG_HARD_MS", 6000),
        session_grace_sec=_env_float("SESSION_GRACE_SEC", 10.0),
        stream_keepalive_sec=_env_float("STREAM_KEEPALIVE_SEC", 30.0),
        stream_refresh_sec=_env_float("STREAM_REFRESH_SEC", 300.0),
        stall_rotate_sec=_env_float("STALL_ROTATE_SEC", 8.0),
        context_card=_env_bool("GEMINI_CONTEXT_CARD", True),
        idle_shutdown_sec=_env_float("IDLE_SHUTDOWN_SEC", 30.0),
        admission_fail_closed_sec=_env_float("ADMISSION_FAIL_CLOSED_SEC", 30.0),
        usage_interval_sec=_env_float("USAGE_INTERVAL_SEC", 15.0),
        standalone_max_spend_usd=_env_float("STANDALONE_MAX_SPEND_USD", 5.0),
        gemini_input_usd_per_min=_env_float("GEMINI_INPUT_USD_PER_MIN", 0.0053),
        gemini_output_usd_per_min=_env_float("GEMINI_OUTPUT_USD_PER_MIN", 0.0315),
        openai_usd_per_min=_env_float("OPENAI_TRANSLATE_USD_PER_MIN", 0.034),
        mock_delay_ms=_env_int("MOCK_DELAY_MS", 1200),
    )

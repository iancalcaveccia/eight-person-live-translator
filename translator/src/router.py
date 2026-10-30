"""Reconciles translation sessions in ONE group media room to demand.

Demand (CONTRACT.md §3): for each admitted speaker S with an unmuted mic,
targets(S) = {listen_lang of every OTHER admitted human} minus S.speak_lang
(unless S.speak_lang == "auto"). One session per (gathering, group, S, target)
is shared by every listener who wants that target.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from audio import (
    BleedGuard,
    SpeakerInput,
    default_resampler_factory,
    livekit_track_frames,
)
from config import (
    ATTR_AGENT_STATUS,
    ATTR_EPOCH,
    ATTR_LISTEN_LANG,
    ATTR_SPEAK_LANG,
    AUTO_LANG,
    SUPPORTED_LANGS,
    Settings,
)
from control_plane import ControlPlaneClient, ControlPlaneError, TranslationPolicy
from events import RoomIO
from metering import estimate_cost_usd
from providers import provider_chain
from providers.base import TranslationProvider
from session import SessionKey, TranslationSession, comparison_track_name

logger = logging.getLogger("translator.router")


# --- Pure demand computation ---------------------------------------------------


@dataclass(frozen=True)
class HumanInfo:
    identity: str
    speak_lang: str  # en | pl | es | auto
    listen_lang: str  # en | pl | es
    has_mic: bool


def parse_human(
    identity: str, attributes: dict[str, str] | None, *, has_mic: bool
) -> HumanInfo | None:
    attrs = attributes or {}
    speak = (attrs.get(ATTR_SPEAK_LANG) or "").strip()
    listen = (attrs.get(ATTR_LISTEN_LANG) or "").strip()
    if listen not in SUPPORTED_LANGS:
        return None
    if speak not in SUPPORTED_LANGS and speak != AUTO_LANG:
        return None
    return HumanInfo(
        identity=identity, speak_lang=speak, listen_lang=listen, has_mic=has_mic
    )


def compute_demand(humans: list[HumanInfo]) -> dict[tuple[str, str], bool]:
    """Return {(speaker, target): echo_target} for every required session."""
    desired: dict[tuple[str, str], bool] = {}
    for s in humans:
        if not s.has_mic:
            continue
        targets = {h.listen_lang for h in humans if h.identity != s.identity}
        if s.speak_lang != AUTO_LANG:
            targets.discard(s.speak_lang)
        for t in targets:
            desired[(s.identity, t)] = s.speak_lang == AUTO_LANG
    return desired


# --- Admission ------------------------------------------------------------------


@dataclass
class _Entry:
    status: str  # pending | allowed | denied
    first_seen: float
    epoch_attr: str | None
    checked_at: float = 0.0


EvictFn = Callable[[str, str], Awaitable[None]]


class AdmissionManager:
    def __init__(
        self,
        *,
        client: ControlPlaneClient,
        room_name: str,
        settings: Settings,
        evict: EvictFn,
        on_change: Callable[[], None],
        on_policy: Callable[[TranslationPolicy], None],
        on_room_unknown: Callable[[], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._room = room_name
        self._settings = settings
        self._evict = evict
        self._on_change = on_change
        self._on_policy = on_policy
        self._on_room_unknown = on_room_unknown
        self._clock = clock
        self.entries: dict[str, _Entry] = {}
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self.consecutive_errors = 0
        self.evicted: list[tuple[str, str]] = []

    @property
    def standalone(self) -> bool:
        return self._client.standalone

    def start(self) -> None:
        if self._task is None and not self.standalone:
            self._task = asyncio.create_task(self._loop(), name="admission")

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

    def note_present(self, identity: str, epoch_attr: str | None) -> None:
        entry = self.entries.get(identity)
        if entry is None:
            self.entries[identity] = _Entry(
                status="allowed" if self.standalone else "pending",
                first_seen=self._clock(),
                epoch_attr=epoch_attr,
            )
            self._wake.set()
        elif entry.epoch_attr != epoch_attr:
            entry.epoch_attr = epoch_attr
            if not self.standalone:
                entry.status = "pending"
                self._wake.set()

    def note_left(self, identity: str) -> None:
        self.entries.pop(identity, None)

    def is_allowed(self, identity: str) -> bool:
        if self.standalone:
            return True
        entry = self.entries.get(identity)
        return entry is not None and entry.status == "allowed"

    async def _loop(self) -> None:
        backoff = 1.0
        while True:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._wake.wait(), timeout=self._settings.admission_reverify_sec
                )
            self._wake.clear()
            await asyncio.sleep(self._settings.admission_debounce_sec)
            ok = await self.check_all()
            if ok:
                backoff = 1.0
            else:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 8.0)
                self._wake.set()

    async def check_all(self) -> bool:
        identities = sorted(self.entries)
        if not identities:
            return True
        try:
            result = await self._client.admission(
                room=self._room, identities=identities
            )
        except ControlPlaneError as exc:
            self.consecutive_errors += 1
            logger.warning(
                "admission check failed (%d): %s", self.consecutive_errors, exc
            )
            await self._fail_closed_stale_pending()
            return False
        self.consecutive_errors = 0
        if result.room_unknown:
            logger.error(
                "control plane does not know room %s; evicting everyone", self._room
            )
            for identity in identities:
                await self._deny(identity, "unknown_room")
            self._on_room_unknown()
            return True
        changed = False
        now = self._clock()
        for identity in identities:
            entry = self.entries.get(identity)
            if entry is None:
                continue
            decision = result.participants.get(identity)
            entry.checked_at = now
            if decision is None or not decision.allowed:
                await self._deny(identity, decision.reason if decision else "unknown")
                changed = True
                continue
            if decision.epoch is not None and str(decision.epoch) != (
                entry.epoch_attr or ""
            ):
                await self._deny(identity, "stale_epoch")
                changed = True
                continue
            if entry.status != "allowed":
                entry.status = "allowed"
                changed = True
        self._on_policy(result.translation)
        if changed:
            self._on_change()
        return True

    async def _fail_closed_stale_pending(self) -> None:
        now = self._clock()
        for identity, entry in list(self.entries.items()):
            if (
                entry.status == "pending"
                and now - entry.first_seen >= self._settings.admission_fail_closed_sec
            ):
                await self._deny(identity, "admission_unavailable")
                self._on_change()

    async def _deny(self, identity: str, reason: str) -> None:
        entry = self.entries.get(identity)
        if entry is not None and entry.status == "denied":
            return
        if entry is not None:
            entry.status = "denied"
        self.evicted.append((identity, reason))
        logger.warning("evicting %s from %s: %s", identity, self._room, reason)
        try:
            await self._evict(identity, reason)
        except Exception as exc:
            logger.warning("eviction of %s failed: %s", identity, exc)


# --- Router ----------------------------------------------------------------------

FramesFactory = Callable[[Any], AsyncIterator[bytes]]


class TranslationRouter:
    def __init__(
        self,
        *,
        room: Any,
        room_io: RoomIO,
        providers: dict[str, TranslationProvider],
        settings: Settings,
        control_plane: ControlPlaneClient,
        gathering_id: str,
        group_id: str,
        evict: EvictFn,
        shutdown: Callable[[str], None] | None = None,
        frames_factory: FramesFactory = livekit_track_frames,
        resampler_factory: Callable[[int, int], Any] = default_resampler_factory,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._room = room
        self._io = room_io
        self._providers = providers
        self._settings = settings
        self._cp = control_plane
        self.gathering_id = gathering_id
        self.group_id = group_id
        self._shutdown = shutdown
        self._frames_factory = frames_factory
        self._resampler_factory = resampler_factory
        self._clock = clock

        self._speaker_tracks: dict[str, Any] = {}
        self.inputs: dict[str, SpeakerInput] = {}
        self.sessions: dict[SessionKey, TranslationSession] = {}
        self.compare_sessions: dict[tuple[SessionKey, str], TranslationSession] = {}
        self._grace: dict[SessionKey, asyncio.Task] = {}
        self._pending_records: list[dict] = []
        self._tasks: list[asyncio.Task] = []
        self._detached: set[asyncio.Task] = set()
        self._reconcile_handle: asyncio.TimerHandle | None = None
        self._reconcile_lock = asyncio.Lock()
        self._closed = False
        self.translation_allowed = True
        self.budget_state = "ok"
        self.default_provider = settings.translation_provider
        self._standalone_spend = 0.0
        self._last_human_seen = clock()
        self.shutdown_reason: str | None = None

        self.bleed_guard = BleedGuard(
            enabled=settings.bleed_guard,
            corr_threshold=settings.bleed_corr_threshold,
            level_diff_db=settings.bleed_level_diff_db,
            window_ms=settings.bleed_window_ms,
            max_lag_ms=settings.bleed_max_lag_ms,
            persist_evals=settings.bleed_persist_evals,
        )
        self.admission = AdmissionManager(
            client=control_plane,
            room_name=getattr(room, "name", ""),
            settings=settings,
            evict=evict,
            on_change=self.schedule_reconcile,
            on_policy=self._apply_policy,
            on_room_unknown=lambda: self._request_shutdown("unknown_room"),
            clock=clock,
        )

    # --- lifecycle -------------------------------------------------------------

    def start(self) -> None:
        from livekit import rtc

        room = self._room

        @room.on("participant_connected")
        def _on_conn(p: Any) -> None:
            self._note_participant(p)
            self.schedule_reconcile()

        @room.on("participant_disconnected")
        def _on_disc(p: Any) -> None:
            self._on_participant_left(p.identity)
            self.schedule_reconcile()

        @room.on("participant_attributes_changed")
        def _on_attrs(_changed: dict[str, str], p: Any) -> None:
            if getattr(p, "identity", None) in getattr(room, "remote_participants", {}):
                self._note_participant(p)
            self.schedule_reconcile()

        @room.on("track_subscribed")
        def _on_subscribed(track: Any, _pub: Any, participant: Any) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO and not self._is_agent(
                participant
            ):
                self._speaker_tracks[participant.identity] = track
                self.schedule_reconcile()

        @room.on("track_unsubscribed")
        def _on_unsubscribed(track: Any, _pub: Any, participant: Any) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                if self._speaker_tracks.get(participant.identity) is track:
                    self._speaker_tracks.pop(participant.identity, None)
                self.schedule_reconcile()

        @room.on("track_muted")
        def _on_muted(_pub: Any, _p: Any) -> None:
            self.schedule_reconcile()

        @room.on("track_unmuted")
        def _on_unmuted(_pub: Any, _p: Any) -> None:
            self.schedule_reconcile()

        for p in room.remote_participants.values():
            if self._is_agent(p):
                continue
            self._note_participant(p)
            for pub in p.track_publications.values():
                if pub.track is not None and pub.kind == rtc.TrackKind.KIND_AUDIO:
                    self._speaker_tracks[p.identity] = pub.track

        self.admission.start()
        self._tasks = [
            asyncio.create_task(self._usage_loop(), name="usage"),
            asyncio.create_task(self._stats_loop(), name="stats"),
            asyncio.create_task(self._idle_loop(), name="idle"),
        ]
        if self._cp.standalone:
            logger.warning(
                "STANDALONE MODE: CONTROL_PLANE_URL is not set; every participant is "
                "admitted without authorization. Never run like this in production."
            )
        self.schedule_reconcile()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._reconcile_handle is not None:
            self._reconcile_handle.cancel()
        for task in self._grace.values():
            task.cancel()
        self._grace.clear()
        await self.admission.aclose()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self._close_all_sessions("shutdown")
        await self._await_detached()
        await asyncio.gather(
            *(i.aclose() for i in self.inputs.values()), return_exceptions=True
        )
        self.inputs.clear()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._report_usage(final=True), timeout=5.0)
        with contextlib.suppress(Exception):
            await self._cp.aclose()

    # --- participants -------------------------------------------------------------

    @staticmethod
    def _is_agent(p: Any) -> bool:
        from livekit import rtc

        return getattr(p, "kind", None) == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT

    def _note_participant(self, p: Any) -> None:
        if self._is_agent(p):
            return
        self._last_human_seen = self._clock()
        self.admission.note_present(p.identity, (p.attributes or {}).get(ATTR_EPOCH))

    def _on_participant_left(self, identity: str) -> None:
        self._speaker_tracks.pop(identity, None)
        self.admission.note_left(identity)
        for key in [k for k in self.sessions if k.speaker == identity]:
            self._close_detached(self.sessions.pop(key), "speaker_left")
            grace = self._grace.pop(key, None)
            if grace:
                grace.cancel()
        for ck in [k for k in self.compare_sessions if k[0].speaker == identity]:
            self._close_detached(self.compare_sessions.pop(ck), "speaker_left")
        inp = self.inputs.pop(identity, None)
        if inp is not None:
            self._spawn(inp.aclose())

    def _remote_humans(self) -> list[Any]:
        return [
            p for p in self._room.remote_participants.values() if not self._is_agent(p)
        ]

    def _has_unmuted_mic(self, p: Any) -> bool:
        from livekit import rtc

        return any(
            pub.kind == rtc.TrackKind.KIND_AUDIO and not pub.muted
            for pub in p.track_publications.values()
        )

    def admitted_humans(self) -> list[HumanInfo]:
        out: list[HumanInfo] = []
        for p in self._remote_humans():
            if not self.admission.is_allowed(p.identity):
                continue
            has_mic = p.identity in self._speaker_tracks and self._has_unmuted_mic(p)
            info = parse_human(p.identity, p.attributes, has_mic=has_mic)
            if info is not None:
                out.append(info)
        return out

    # --- reconciliation -------------------------------------------------------------

    def schedule_reconcile(self) -> None:
        if self._closed:
            return
        loop = asyncio.get_event_loop()
        if self._reconcile_handle is not None:
            self._reconcile_handle.cancel()
        self._reconcile_handle = loop.call_later(
            self._settings.reconcile_debounce_sec,
            lambda: self._spawn(self.reconcile()),
        )

    async def reconcile(self) -> None:
        if self._closed:
            return
        async with self._reconcile_lock:
            humans = self.admitted_humans()
            self._sync_inputs(humans)
            desired_pairs = compute_demand(humans) if self.translation_allowed else {}
            desired = {
                SessionKey(self.gathering_id, self.group_id, s, t): echo
                for (s, t), echo in desired_pairs.items()
            }

            # Sessions no longer wanted.
            for key in list(self.sessions):
                wanted = key in desired
                echo_ok = wanted and self._echo_of(key) == desired[key]
                if echo_ok:
                    pending = self._grace.pop(key, None)
                    if pending:
                        pending.cancel()
                    continue
                immediate = (
                    not self.translation_allowed
                    or key.speaker not in self.inputs
                    or wanted  # echo mode changed (auto <-> declared): recreate now
                )
                if immediate:
                    pending = self._grace.pop(key, None)
                    if pending:
                        pending.cancel()
                    self._close_detached(self.sessions.pop(key), "not_needed")
                elif key not in self._grace:
                    # Mute / last listener left: keep warm briefly to avoid thrash.
                    self._grace[key] = asyncio.create_task(self._grace_teardown(key))

            # New sessions.
            for key, echo in desired.items():
                if key in self.sessions:
                    continue
                inp = self.inputs.get(key.speaker)
                if inp is None:
                    continue
                chain = provider_chain(
                    self._providers,
                    preferred=self.default_provider,
                    target_lang=key.target,
                    fallback_enabled=self._settings.provider_fallback,
                )
                if not chain:
                    logger.error("no provider can serve target %s", key.target)
                    continue
                session = TranslationSession(
                    key=key,
                    speaker_input=inp,
                    providers=chain,
                    echo_target=echo,
                    room_io=self._io,
                    settings=self._settings,
                    resampler_factory=self._resampler_factory,
                )
                self.sessions[key] = session
                try:
                    await session.start()
                except Exception:
                    logger.exception("failed to start session %s", key.short())
                    self.sessions.pop(key, None)
                    with contextlib.suppress(Exception):
                        await session.aclose("start_failed")

            self._designate_source_captions()
            await self._reconcile_comparisons(desired)

    def _echo_of(self, key: SessionKey) -> bool:
        s = self.sessions.get(key)
        return bool(s and s._echo)

    def _designate_source_captions(self) -> None:
        by_speaker: dict[str, list[SessionKey]] = {}
        for key in self.sessions:
            by_speaker.setdefault(key.speaker, []).append(key)
        for keys in by_speaker.values():
            first = min(keys, key=lambda k: k.target)
            for k in keys:
                self.sessions[k].publish_source = k == first

    async def _reconcile_comparisons(self, desired: dict[SessionKey, bool]) -> None:
        wanted: set[tuple[SessionKey, str]] = set()
        if self._settings.provider_compare and self.translation_allowed:
            for key in desired:
                primary = self.sessions.get(key)
                if primary is None:
                    continue
                for name, prov in self._providers.items():
                    if (
                        name == primary.provider.name
                        or name == "mock"
                        or not prov.supports(key.target)
                    ):
                        continue
                    wanted.add((key, name))
        for ck in list(self.compare_sessions):
            if ck not in wanted:
                self._close_detached(self.compare_sessions.pop(ck), "not_needed")
        for ck in wanted:
            if ck in self.compare_sessions:
                continue
            key, name = ck
            inp = self.inputs.get(key.speaker)
            if inp is None:
                continue
            session = TranslationSession(
                key=key,
                speaker_input=inp,
                providers=[self._providers[name]],
                echo_target=desired[key],
                room_io=self._io,
                settings=self._settings,
                track_name=comparison_track_name(key.speaker, key.target, name),
                publish_captions=False,
                publish_source=False,
                emit_events=False,
                resampler_factory=self._resampler_factory,
            )
            self.compare_sessions[ck] = session
            try:
                await session.start()
            except Exception:
                logger.exception("failed to start comparison session")
                self.compare_sessions.pop(ck, None)

    def _sync_inputs(self, humans: list[HumanInfo]) -> None:
        wanted = {h.identity for h in humans if h.identity in self._speaker_tracks}
        for identity in list(self.inputs):
            inp = self.inputs[identity]
            track = self._speaker_tracks.get(identity)
            if identity not in wanted or getattr(inp, "_track", None) is not track:
                self.inputs.pop(identity)
                for key in [k for k in self.sessions if k.speaker == identity]:
                    self._close_detached(self.sessions.pop(key), "input_changed")
                for ck in [
                    k for k in self.compare_sessions if k[0].speaker == identity
                ]:
                    self._close_detached(self.compare_sessions.pop(ck), "input_changed")
                self._spawn(inp.aclose())
        for identity in wanted:
            if identity in self.inputs:
                continue
            track = self._speaker_tracks[identity]
            inp = SpeakerInput(
                identity=identity,
                frames=self._frames_factory(track),
                settings=self._settings,
                bleed_guard=self.bleed_guard,
                on_onset=self._on_onset,
                resampler_factory=self._resampler_factory,
            )
            inp._track = track  # type: ignore[attr-defined]
            self.inputs[identity] = inp
            inp.start()

    def _on_onset(self, identity: str, mono_ts: float) -> None:
        wall_ms = (time.time() - (self._clock() - mono_ts)) * 1000.0
        self._spawn(
            self._io.publish_event(
                {"t": "onset", "speaker": identity, "ts": round(wall_ms)}
            )
        )

    async def _grace_teardown(self, key: SessionKey) -> None:
        try:
            await asyncio.sleep(self._settings.session_grace_sec)
        except asyncio.CancelledError:
            return
        self._grace.pop(key, None)
        humans = self.admitted_humans()
        still = compute_demand(humans) if self.translation_allowed else {}
        if (key.speaker, key.target) not in still and key in self.sessions:
            self._close_detached(self.sessions.pop(key), "grace_expired")

    def _close_detached(self, session: TranslationSession, reason: str) -> None:
        records = session.take_usage_records()
        self._pending_records.extend(records)

        async def _close() -> None:
            await session.aclose(reason)
            self._pending_records.extend(session.take_usage_records())

        self._spawn(_close())

    async def _close_all_sessions(self, reason: str) -> None:
        sessions = [*self.sessions.values(), *self.compare_sessions.values()]
        self.sessions.clear()
        self.compare_sessions.clear()
        await asyncio.gather(
            *(s.aclose(reason) for s in sessions), return_exceptions=True
        )
        for s in sessions:
            self._pending_records.extend(s.take_usage_records())

    async def _await_detached(self, timeout: float = 5.0) -> None:
        current = asyncio.current_task()
        others = [t for t in self._detached if t is not current]
        if others:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(*others, return_exceptions=True), timeout=timeout
                )

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._detached.add(task)
        task.add_done_callback(self._detached.discard)
        return task

    # --- budget / policy ---------------------------------------------------------------

    def _apply_policy(self, policy: TranslationPolicy) -> None:
        if policy.default_provider and policy.default_provider in self._providers:
            self.default_provider = policy.default_provider
        if policy.allowed and not self.translation_allowed:
            self.translation_allowed = True
            self.budget_state = "ok"
            self._spawn(
                self._io.publish_event({"t": "budget", "state": "ok", "reason": None})
            )
            self.schedule_reconcile()
            self._spawn(self._publish_status())
        elif not policy.allowed and self.translation_allowed:
            self.translation_allowed = False
            self.budget_state = "exceeded"
            logger.warning("translation stopped by control plane: %s", policy.reason)
            self._spawn(
                self._io.publish_event(
                    {"t": "budget", "state": "exceeded", "reason": policy.reason}
                )
            )
            self._spawn(self._close_all_sessions(policy.reason or "budget"))
            self._spawn(self._publish_status())

    async def _report_usage(self, *, final: bool = False) -> None:
        records = list(self._pending_records)
        for s in [*self.sessions.values(), *self.compare_sessions.values()]:
            records.extend(s.take_usage_records())
        self._pending_records = []
        if not records:
            return
        if self._cp.standalone:
            self._standalone_spend += sum(
                estimate_cost_usd(r, self._settings) for r in records
            )
            if self._standalone_spend >= self._settings.standalone_max_spend_usd:
                self._apply_policy(TranslationPolicy(False, "standalone_cap"))
            return
        try:
            result = await self._cp.usage(
                room=getattr(self._room, "name", ""),
                gathering_id=self.gathering_id,
                group_id=self.group_id,
                records=records,
            )
        except ControlPlaneError as exc:
            logger.warning("usage report failed: %s", exc)
            self._pending_records = (records + self._pending_records)[-200:]
            return
        spend = result.spend or {}
        cap = spend.get("capGatheringUsd")
        used = spend.get("gatheringUsd")
        if (
            result.translation.allowed
            and isinstance(cap, (int, float))
            and isinstance(used, (int, float))
            and cap > 0
            and used >= 0.8 * cap
            and self.budget_state == "ok"
        ):
            self.budget_state = "warning"
            await self._io.publish_event(
                {"t": "budget", "state": "warning", "reason": "gathering_cap_80pct"}
            )
        if not final:
            self._apply_policy(result.translation)

    async def _usage_loop(self) -> None:
        while True:
            await asyncio.sleep(self._settings.usage_interval_sec)
            with contextlib.suppress(Exception):
                await self._report_usage()

    async def _stats_loop(self) -> None:
        while True:
            await asyncio.sleep(self._settings.stats_interval_sec)
            sessions = [s.stats() for s in self.sessions.values()]
            if sessions:
                await self._io.publish_event({"t": "stats", "sessions": sessions})
            await self._publish_status()

    async def _publish_status(self) -> None:
        status = {
            "budget": self.budget_state,
            "sessions": len(self.sessions),
            "provider": self.default_provider,
        }
        await self._io.set_attributes(
            {ATTR_AGENT_STATUS: json.dumps(status, separators=(",", ":"))}
        )

    async def _idle_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            if self._remote_humans():
                self._last_human_seen = self._clock()
                continue
            if self.sessions or self.compare_sessions:
                await self._close_all_sessions("idle")
            if (
                self._clock() - self._last_human_seen
                >= self._settings.idle_shutdown_sec
            ):
                self._request_shutdown("idle")
                return

    def _request_shutdown(self, reason: str) -> None:
        if self.shutdown_reason is not None:
            return
        self.shutdown_reason = reason
        logger.info("router requesting job shutdown: %s", reason)
        self._spawn(self._close_all_sessions(reason))
        if self._shutdown is not None:
            self._shutdown(reason)

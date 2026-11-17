"""TranslationRouter: demand -> sessions, admission/eviction, budget, idle."""

from __future__ import annotations

import asyncio

import numpy as np
from helpers import (
    FakeControlPlane,
    FakeRoom,
    fast,
    frames_of,
    human,
    paced_then_silence,
    silence,
    speech_like,
    wait_for,
)

from audio import simple_resampler_factory
from control_plane import ControlPlaneClient, TranslationPolicy
from events import FakeRoomIO
from providers.mock import MockProvider
from router import TranslationRouter

SPEECH = np.concatenate([silence(0.2), speech_like(6.0, seed=11)])


def frames_factory(track):
    return paced_then_silence(frames_of(SPEECH))


class Harness:
    def __init__(
        self, participants, *, control_plane=None, providers=None, settings=None
    ):
        self.room = FakeRoom(participants=participants)
        self.io = FakeRoomIO()
        self.cp = control_plane or ControlPlaneClient(base_url="", secret="")
        self.evicted: list[tuple[str, str]] = []
        self.shutdowns: list[str] = []
        self.providers = providers or {"mock": MockProvider(delay_ms=200)}
        self.router = TranslationRouter(
            room=self.room,
            room_io=self.io,
            providers=self.providers,
            settings=settings or fast(translation_provider="mock"),
            control_plane=self.cp,
            gathering_id="g1",
            group_id="grp1",
            evict=self._evict,
            shutdown=self.shutdowns.append,
            frames_factory=frames_factory,
            resampler_factory=simple_resampler_factory,
        )

    async def _evict(self, identity: str, reason: str) -> None:
        self.evicted.append((identity, reason))
        if identity in self.room.remote_participants:
            self.room.remove(identity)

    def pairs(self) -> set[tuple[str, str]]:
        return {(k.speaker, k.target) for k in self.router.sessions}

    async def close(self) -> None:
        await self.router.aclose()


async def test_eight_people_three_languages_sixteen_shared_sessions():
    people = [human(f"en{i}", "en", "en") for i in range(3)]
    people += [human(f"pl{i}", "pl", "pl") for i in range(3)]
    people += [human(f"es{i}", "es", "es") for i in range(2)]
    h = Harness(people)
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 16, timeout=5)
    names = h.io.track_names()
    assert len(names) == 16
    assert "tx:en0:pl" in names and "tx:es1:en" in names and "tx:pl2:es" in names
    assert all(
        k.gathering_id == "g1" and k.group_id == "grp1" for k in h.router.sessions
    )
    # Exactly one SpeakerInput per human mic, shared by that speaker's sessions.
    assert len(h.router.inputs) == 8
    await h.close()


async def test_one_english_speaker_three_spanish_listeners_single_session():
    people = [human("en", "en", "en")] + [
        human(f"es{i}", "es", "es", muted=True) for i in range(3)
    ]
    h = Harness(people)
    h.router.start()
    assert await wait_for(lambda: h.pairs() == {("en", "es")}, timeout=5)
    await asyncio.sleep(0.3)
    assert h.pairs() == {("en", "es")}
    await h.close()


async def test_source_caption_designation_one_per_speaker():
    people = [
        human("a", "es", "es"),
        human("b", "pl", "pl", muted=True),
        human("c", "en", "en", muted=True),
    ]
    h = Harness(people)
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    flags = {k.target: s.publish_source for k, s in h.router.sessions.items()}
    assert flags == {"en": True, "pl": False}
    await h.close()


async def test_crosstalk_is_fed_once_per_speaker_and_mutes_all_their_streams():
    people = [
        human("a", "es", "es"),
        human("b", "pl", "pl"),
        human("c", "en", "en", muted=True),
    ]
    h = Harness(people)
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 4, timeout=5)
    feeds = {
        (k.speaker, k.target): s.crosstalk_feed for k, s in h.router.sessions.items()
    }
    assert feeds == {
        ("a", "en"): True,
        ("a", "pl"): False,
        ("b", "en"): True,
        ("b", "es"): False,
    }
    det = h.router.crosstalk
    assert det._mics["a"].declared == "es" and det._mics["b"].declared == "pl"

    # b's mic carries a's Spanish: both of b's streams are told to stop.
    started: list[str] = []
    for k, s in h.router.sessions.items():
        s.crosstalk_started = lambda k=k: started.append(f"{k.speaker}->{k.target}")
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
        det.note_input("a", " ".join(words[i : i + 3]), "es")
        det.note_input("b", " ".join(words[i : i + 3]), "es")
    assert sorted(started) == ["b->en", "b->es"]
    assert det.is_held("b") and not det.is_held("a")
    await h.close()


async def test_diagnostics_reach_the_control_plane_with_the_usage_reports():
    cp = FakeControlPlane()
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")], control_plane=cp)
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    assert await wait_for(lambda: any(c["events"] for c in cp.event_calls), timeout=5)
    kinds = [e["kind"] for c in cp.event_calls for e in c["events"]]
    assert "worker_started" in kinds and kinds.count("session_started") == 2
    await h.close()
    kinds = [e["kind"] for c in cp.event_calls for e in c["events"]]
    assert kinds.count("session_closed") == 2
    started = [
        e for c in cp.event_calls for e in c["events"] if e["kind"] == "session_started"
    ]
    assert {(e["speaker"], e["data"]["speak_lang"]) for e in started} == {
        ("a", "es"),
        ("b", "pl"),
    }


async def test_diagnostics_never_pile_up_when_the_control_plane_is_down():
    cp = FakeControlPlane()
    cp.fail = True
    h = Harness([human("a", "es", "es")], control_plane=cp)
    for i in range(800):
        h.router._diag("minute", "a", "pl", n=i)
    assert len(h.router._diag_events) == 500
    await h.router._flush_diag()
    assert len(h.router._diag_events) == 500
    await h.close()


async def test_admission_denial_evicts_and_excludes_from_demand():
    cp = FakeControlPlane()
    cp.denied["intruder"] = "not_in_group"
    people = [
        human("a", "es", "es"),
        human("b", "pl", "pl"),
        human("intruder", "en", "en"),
    ]
    h = Harness(people, control_plane=cp)
    h.router.start()
    assert await wait_for(lambda: ("intruder", "not_in_group") in h.evicted, timeout=5)
    assert await wait_for(lambda: h.pairs() == {("a", "pl"), ("b", "es")}, timeout=5)
    assert not any(
        k.speaker == "intruder" or k.target == "en" for k in h.router.sessions
    )
    await h.close()


async def test_old_token_with_stale_epoch_is_evicted():
    cp = FakeControlPlane()
    cp.epochs["replayer"] = 5  # server says the active epoch is 5
    people = [human("a", "es", "es"), human("replayer", "pl", "pl", epoch="3")]
    h = Harness(people, control_plane=cp)
    h.router.start()
    assert await wait_for(lambda: ("replayer", "stale_epoch") in h.evicted, timeout=5)
    await asyncio.sleep(0.3)
    assert h.router.sessions == {}
    await h.close()


async def test_nobody_is_translated_before_admission_completes():
    cp = FakeControlPlane()
    cp.fail = True
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")], control_plane=cp)
    h.router.start()
    await asyncio.sleep(0.25)
    assert h.router.sessions == {}
    # Fail closed: never-admitted humans are removed after the deadline.
    assert await wait_for(lambda: len(h.evicted) == 2, timeout=5)
    assert all(reason == "admission_unavailable" for _, reason in h.evicted)
    await h.close()


async def test_unknown_room_evicts_everyone_and_shuts_down():
    cp = FakeControlPlane()
    cp.room_unknown = True
    h = Harness([human("a", "es", "es")], control_plane=cp)
    h.router.start()
    assert await wait_for(lambda: h.shutdowns == ["unknown_room"], timeout=5)
    assert ("a", "unknown_room") in h.evicted
    await h.close()


async def test_budget_exceeded_closes_every_session_and_blocks_new_ones():
    cp = FakeControlPlane()
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")], control_plane=cp)
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    cp.usage_translation = TranslationPolicy(False, "gathering_cap")
    cp.translation = TranslationPolicy(False, "gathering_cap")
    assert await wait_for(
        lambda: h.router.sessions == {} and not h.router.translation_allowed, timeout=5
    )
    assert any(
        e == {"t": "budget", "state": "exceeded", "reason": "gathering_cap"}
        for e in h.io.events
    )
    await h.router.reconcile()
    assert h.router.sessions == {}
    assert await wait_for(lambda: h.io.tracks == {}, timeout=3)
    await h.close()


async def test_usage_records_follow_contract():
    cp = FakeControlPlane()
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")], control_plane=cp)
    h.router.start()
    assert await wait_for(
        lambda: any(
            r["inputSeconds"] > 0 for c in cp.usage_calls for r in c["records"]
        ),
        timeout=6,
    )
    record = next(r for c in cp.usage_calls for r in c["records"])
    assert set(record) == {
        "speakerId",
        "targetLang",
        "provider",
        "inputSeconds",
        "outputSeconds",
        "sessionSeconds",
        "periodStart",
        "periodEnd",
        "errors",
        "firstAudioMs",
    }
    assert cp.usage_calls[0]["room"] == "grp_test"
    await h.close()


async def test_mute_triggers_grace_teardown():
    a = human("a", "es", "es")
    b = human("b", "pl", "pl")
    h = Harness([a, b])
    h.router.start()
    assert await wait_for(lambda: ("a", "pl") in h.pairs(), timeout=5)
    pub = next(iter(a.track_publications.values()))
    pub.muted = True
    h.room.emit("track_muted", pub, a)
    await asyncio.sleep(0.1)
    assert ("a", "pl") in h.pairs(), "kept warm during grace"
    assert await wait_for(lambda: ("a", "pl") not in h.pairs(), timeout=3)
    await h.close()


async def test_language_change_retargets_sessions():
    a = human("a", "es", "es")
    b = human("b", "pl", "pl")
    h = Harness([a, b])
    h.router.start()
    assert await wait_for(lambda: h.pairs() == {("a", "pl"), ("b", "es")}, timeout=5)
    b.attributes["listen_lang"] = "en"
    h.room.emit("participant_attributes_changed", {"listen_lang": "en"}, b)
    assert await wait_for(lambda: ("a", "en") in h.pairs(), timeout=5)
    assert await wait_for(lambda: ("a", "pl") not in h.pairs(), timeout=3)
    await h.close()


async def test_switching_to_auto_recreates_with_echo():
    a = human("a", "es", "pl")
    b = human("b", "en", "en")
    h = Harness([a, b])
    h.router.start()
    assert await wait_for(lambda: ("a", "en") in h.pairs(), timeout=5)
    assert (
        h.router.sessions[next(k for k in h.router.sessions if k.speaker == "a")]._echo
        is False
    )
    a.attributes["speak_lang"] = "auto"
    h.room.emit("participant_attributes_changed", {"speak_lang": "auto"}, a)
    assert await wait_for(
        lambda: any(k.speaker == "a" and s._echo for k, s in h.router.sessions.items()),
        timeout=5,
    )
    await h.close()


async def test_speaker_leaving_closes_sessions_immediately():
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")])
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    h.room.remove("a")
    assert await wait_for(lambda: ("a", "pl") not in h.pairs(), timeout=1)
    await h.close()


async def test_idle_room_shuts_down_job():
    h = Harness([human("a", "es", "es"), human("b", "pl", "pl")])
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    h.room.remove("a")
    h.room.remove("b")
    assert await wait_for(lambda: h.shutdowns == ["idle"], timeout=5)
    assert h.router.sessions == {}
    await h.close()


async def test_comparison_tracks_when_enabled():
    providers = {
        "gemini": MockProvider(delay_ms=200, name="gemini"),
        "openai": MockProvider(
            delay_ms=200, name="openai", supported_targets=frozenset({"en", "es"})
        ),
    }
    h = Harness(
        [human("a", "pl", "pl"), human("b", "es", "es")],
        providers=providers,
        settings=fast(translation_provider="gemini", provider_compare=True),
    )
    h.router.start()
    assert await wait_for(
        lambda: len(h.router.sessions) == 2 and len(h.router.compare_sessions) == 1,
        timeout=5,
    )
    names = h.io.track_names()
    # OpenAI cannot target Polish, so only the a->es pair gets a comparison track.
    assert "txc:a:es:openai" in names
    assert not any(n.startswith("txc:b:pl") for n in names)
    await h.close()


async def test_openai_default_still_serves_polish_via_gemini():
    providers = {
        "gemini": MockProvider(delay_ms=200, name="gemini"),
        "openai": MockProvider(
            delay_ms=200, name="openai", supported_targets=frozenset({"en", "es"})
        ),
    }
    h = Harness(
        [human("a", "es", "es"), human("b", "pl", "pl")],
        providers=providers,
        settings=fast(translation_provider="openai"),
    )
    h.router.start()
    assert await wait_for(lambda: len(h.router.sessions) == 2, timeout=5)
    by_target = {k.target: s.provider.name for k, s in h.router.sessions.items()}
    assert by_target == {"pl": "gemini", "es": "openai"}
    await h.close()

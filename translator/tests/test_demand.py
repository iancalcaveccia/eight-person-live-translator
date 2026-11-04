"""Demand rules from CONTRACT.md §3 (pure function)."""

from __future__ import annotations

from router import HumanInfo, compute_demand, parse_human


def h(identity: str, speak: str, listen: str, mic: bool = True) -> HumanInfo:
    return HumanInfo(
        identity=identity, speak_lang=speak, listen_lang=listen, has_mic=mic
    )


def test_empty_room_has_no_sessions():
    assert compute_demand([]) == {}


def test_two_languages_both_directions():
    d = compute_demand([h("a", "es", "es"), h("b", "pl", "pl")])
    assert d == {("a", "pl"): False, ("b", "es"): False}


def test_same_language_is_native_passthrough():
    assert compute_demand([h("a", "pl", "pl"), h("b", "pl", "pl")]) == {}


def test_self_is_excluded_from_listener_demand():
    # a's own listening language (pl) must not create an (a, pl) session.
    d = compute_demand([h("a", "es", "pl"), h("b", "en", "en")])
    assert ("a", "pl") not in d
    assert d == {("a", "en"): False, ("b", "pl"): False}


def test_cross_speak_listen_needs_nothing():
    # a speaks es and listens pl; b speaks pl and listens es -> both native.
    assert compute_demand([h("a", "es", "pl"), h("b", "pl", "es")]) == {}


def test_eight_people_three_languages_caps_at_sixteen():
    people = [
        h("en1", "en", "en"),
        h("en2", "en", "en"),
        h("en3", "en", "en"),
        h("pl1", "pl", "pl"),
        h("pl2", "pl", "pl"),
        h("pl3", "pl", "pl"),
        h("es1", "es", "es"),
        h("es2", "es", "es"),
    ]
    d = compute_demand(people)
    assert len(d) == 16  # 8 speakers x 2 other languages
    assert all(not echo for echo in d.values())
    assert {t for (s, t) in d if s == "en1"} == {"pl", "es"}


def test_one_english_speaker_three_spanish_listeners_one_session():
    people = [
        h("en", "en", "en"),
        h("es1", "es", "es", mic=False),
        h("es2", "es", "es", mic=False),
        h("es3", "es", "es", mic=False),
    ]
    assert compute_demand(people) == {("en", "es"): False}


def test_muted_speaker_creates_no_outgoing_sessions_but_still_listens():
    d = compute_demand([h("a", "en", "en", mic=False), h("b", "es", "es")])
    assert d == {("b", "en"): False}


def test_auto_speaker_targets_every_other_listener_language_with_echo():
    d = compute_demand([h("a", "auto", "en"), h("b", "pl", "pl"), h("c", "en", "en")])
    assert d[("a", "pl")] is True
    assert d[("a", "en")] is True  # c listens en; a may be speaking English
    assert d[("b", "en")] is False
    assert ("c", "pl") in d


def test_parse_human_validates_languages():
    assert (
        parse_human("x", {"speak_lang": "pl", "listen_lang": "es"}, has_mic=True)
        is not None
    )
    assert (
        parse_human("x", {"speak_lang": "auto", "listen_lang": "en"}, has_mic=True)
        is not None
    )
    assert (
        parse_human("x", {"speak_lang": "de", "listen_lang": "en"}, has_mic=True)
        is None
    )
    assert (
        parse_human("x", {"speak_lang": "en", "listen_lang": "auto"}, has_mic=True)
        is None
    )
    assert parse_human("x", {}, has_mic=True) is None
    # Regional Spanish is metadata only; listen_lang stays "es".
    assert parse_human(
        "x",
        {"speak_lang": "es", "listen_lang": "es", "es_region": "es-AR"},
        has_mic=True,
    )

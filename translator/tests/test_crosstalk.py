"""Same words on two mics (crosstalk.py): which mic is leaking, and when not to act."""

from __future__ import annotations

import logging

from crosstalk import CrossTalkDetector, common_in_order, content_words, same_word

ES = "Mañana vamos a comer empanadas en la casa de mi madre, después caminamos por el parque"
ES_WORDS = ES.split()


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def detector(
    levels: dict[str, float] | None = None, **kw
) -> tuple[CrossTalkDetector, Clock, list[str]]:
    clock = Clock()
    held: list[str] = []
    d = CrossTalkDetector(
        level_fn=(lambda who, since: (levels or {}).get(who)),
        on_hold=held.append,
        clock=clock,
        **kw,
    )
    return d, clock, held


def say(
    d: CrossTalkDetector,
    clock: Clock,
    who: str,
    words: list[str],
    lang: str,
    step: float = 0.9,
):
    """Feed `words` as provider chunks of three words, one chunk per `step` seconds."""
    for i in range(0, len(words), 3):
        d.note_input(who, " ".join(words[i : i + 3]), lang)
        clock.t += step


def interleave(d, clock, a, a_lang, b, b_lang, words, lag_chunks=0):
    """`a` and `b` transcribe the same speech, `b` lagging by `lag_chunks` chunks."""
    chunks = [" ".join(words[i : i + 3]) for i in range(0, len(words), 3)]
    for i in range(len(chunks) + lag_chunks):
        if i < len(chunks):
            d.note_input(a, chunks[i], a_lang)
        if i - lag_chunks >= 0 and i - lag_chunks < len(chunks):
            d.note_input(b, chunks[i - lag_chunks], b_lang)
        clock.t += 0.9


def test_words_are_folded_and_filler_is_ignored():
    assert content_words("Mañana, ¿VAMOS a la playa?") == ["manana", "vamos", "playa"]
    assert content_words("Łódź jest piękna, ale zimna") == ["lodz", "piekna", "zimna"]
    assert content_words("the and que nie a y") == []
    assert same_word("rozmawiamy", "rozmawiac") and not same_word("casa", "cosa")
    assert common_in_order(["a1x", "b2x", "c3x"], ["zzz", "a1x", "c3x"]) == 2


def test_spanish_heard_on_a_polish_speakers_mic_is_muted_by_language():
    """The three-language case: Ola (pl) overhears Ian (es); without this her
    stream would re-voice Ian's Spanish into English for a third person."""
    d, clock, held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS)
    assert d.is_held("ola") and not d.is_held("ian")
    assert held == ["ola"]  # one hold start, refreshed afterwards
    assert d.hearing("ola") == "ian"


RU = "утром поедем к бабушке на обед и потом пойдём гулять"


def test_a_far_voice_transcribed_in_cyrillic_is_caught_by_loudness():
    """Live 3-language simulation 2026-11-17: Marta's (en) mic heard Ola's
    Polish, which the provider labelled 'ru' and spelled in Cyrillic, so no
    word could ever match. Ola's mic is ~20 dB louder at that moment."""
    d, _clock, held = detector(levels={"ola": -15.0, "marta": -36.0, "ian": -50.0})
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.set_declared("marta", "en")
    d.note_input("ola", "jutro pojedziemy do babci na obiad", "pl")
    d.note_input("marta", RU, "ru")
    assert d.is_held("marta") and d.hearing("marta") == "ola"
    assert held == ["marta"]


def test_cyrillic_without_a_clearly_louder_mic_is_left_alone():
    d, _clock, held = detector(levels={"ola": -20.0, "marta": -23.0})
    d.set_declared("ola", "pl")
    d.set_declared("marta", "en")
    d.note_input("marta", RU, "ru")
    assert held == []
    d2, _c, held2 = detector(levels={"ola": -15.0, "marta": -36.0})
    d2.set_declared("ola", "pl")
    d2.set_declared("marta", "auto")  # "I switch languages": could be their own
    d2.note_input("marta", RU, "ru")
    assert held2 == []


def test_a_guard_hold_at_speech_onset_measures_the_last_second_only():
    """Both filters on, live simulation: the guard fires ~0.5 s after Ian
    starts; over 3 s Ola's mic averaged near silence, so the overheard voice
    then looked like her own and the hold was lifted at once."""
    clock = Clock()
    seen: dict[str, float] = {}

    def level_fn(who, since):
        seen[who] = clock.t - since
        return {"ian": -15.0, "ola": -36.0}[who]

    d = CrossTalkDetector(level_fn=level_fn, clock=clock)
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.note_guard_leak("ola", "ian", clock.t)
    assert seen == {"ian": 1.0, "ola": 1.0}
    frames(d, clock, 1.0, ian=-15.0, ola=-36.0)
    assert d.is_held("ola") and not d.speaking_own("ola")


def test_a_stale_guard_flag_in_silence_is_ignored_and_cannot_blind_the_check():
    """Deployed worker, live 3-language run: the guard's sticky flag was handed
    over while both mics were at ~-68 dBFS. Taking that as the overheard
    level made every later overheard voice count as the owner's own."""
    levels = {"ian": -68.6, "ola": -67.8}
    d, clock, held = detector(levels=levels)
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.note_guard_leak("ola", "ian", clock.t)
    assert held == [] and not d.is_held("ola")
    # Later Ian talks and Ola's mic overhears him: the check still works.
    levels.update(ian=-15.0, ola=-36.0)
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[:9])
    assert d.is_held("ola")
    frames(d, clock, 2.0, ian=-15.0, ola=-36.0)
    assert d.is_held("ola") and not d.speaking_own("ola")


def test_a_decision_taken_in_a_pause_keeps_the_earlier_loudness_references():
    levels = {"ian": -15.0, "ola": -36.0}
    d, clock, _held = detector(levels=levels)
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[:9])
    levels.update(ian=-60.0, ola=-61.0)  # a pause when the next words land
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[9:])
    levels.update(ian=-15.0, ola=-36.0)
    frames(d, clock, 1.0, ian=-15.0, ola=-36.0)
    assert d.is_held("ola") and not d.speaking_own("ola")


def test_the_loudness_guards_finding_starts_a_hold_and_frames_keep_it():
    d, clock, held = detector(levels={"ian": -15.0, "ola": -36.0})
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.note_guard_leak("ola", "ian", clock.t)
    assert d.is_held("ola") and held == ["ola"]
    frames(d, clock, 6.0, ian=-15.0, ola=-36.0)  # Ian keeps talking
    assert d.is_held("ola")
    d.note_guard_leak("ola", None, clock.t)  # nothing known: ignored
    frames(d, clock, 0.3, ian=-15.0, ola=-14.0)  # Ola speaks up
    assert not d.is_held("ola")
    d.note_guard_leak("ola", "ian", clock.t)  # her own voice wins for now
    assert not d.is_held("ola")


def test_two_mics_overhearing_the_same_speaker_are_both_muted():
    """Live 3-language simulation 2026-11-17: the two far mics mishear Ian the
    same way, so they match each other better than they match Ian. Judging
    only the closest match left both unmuted (undecided pair)."""
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.set_declared("marta", "en")
    far = [
        "Mañana",
        "vamos",
        "a",
        "comer",
        "panadería",
        "en",
        "la",
        "cosa",
        "de",
        "mi",
        "padre,",
        "después",
        "caminamos",
        "por",
        "el",
        "parque",
    ]
    for i in range(0, len(ES_WORDS), 3):
        d.note_input("ian", " ".join(ES_WORDS[i : i + 3]), "es")
        d.note_input("ola", " ".join(far[i : i + 3]), "es")
        d.note_input("marta", " ".join(far[i : i + 3]), "es")
        clock.t += 0.9
    assert d.is_held("ola") and d.is_held("marta") and not d.is_held("ian")


def test_far_copies_match_despite_small_transcription_errors():
    assert same_word("empanadas", "empanada")
    assert same_word("comer", "comen")
    assert same_word("caminamos", "caminemos")
    assert not same_word("casa", "cosa")  # different words stay different
    assert not same_word("padre", "madre")


def test_detection_works_whichever_transcript_arrives_first():
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ola", "es", "ian", "es", ES_WORDS, lag_chunks=1)
    assert d.is_held("ola") and not d.is_held("ian")


def test_a_garbled_label_on_the_leak_still_counts_as_not_their_language():
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "it", ES_WORDS)
    assert d.is_held("ola")


def test_same_language_neighbours_are_told_apart_by_loudness():
    d, clock, _held = detector(levels={"ian": -24.0, "diego": -41.0})
    d.set_declared("ian", "es")
    d.set_declared("diego", "es")
    interleave(d, clock, "ian", "es", "diego", "es", ES_WORDS)
    assert d.is_held("diego") and not d.is_held("ian")


def test_no_clear_evidence_means_no_action():
    """Both mics equally loud and both in their own language: could be two
    people repeating a phrase together. Never silence anyone on a guess."""
    d, clock, held = detector(levels={"ian": -25.0, "diego": -27.0})
    d.set_declared("ian", "es")
    d.set_declared("diego", "es")
    interleave(d, clock, "ian", "es", "diego", "es", ES_WORDS)
    assert not d.is_held("ian") and not d.is_held("diego")
    assert held == []


def test_independent_conversations_in_one_language_never_match():
    d, clock, held = detector(levels={"ian": -24.0, "diego": -45.0})
    d.set_declared("ian", "es")
    d.set_declared("diego", "es")
    other = [
        "Ayer",
        "terminé",
        "el",
        "informe",
        "para",
        "la",
        "oficina",
        "y",
        "mañana",
        "viajo",
        "temprano",
        "hacia",
        "Córdoba",
    ]
    for i in range(0, 15, 3):
        d.note_input("ian", " ".join(ES_WORDS[i : i + 3]), "es")
        d.note_input("diego", " ".join(other[i : i + 3]), "es")
        clock.t += 0.9
    assert held == []


def test_unknown_languages_and_no_loudness_fail_open():
    d, clock, held = detector()
    d.set_declared("ian", "auto")
    d.set_declared("ola", "auto")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS)
    assert held == []


def test_the_hold_ends_a_few_seconds_after_the_last_shared_words():
    d, clock, _held = detector(hold_sec=3.0)
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS)
    assert d.is_held("ola")
    clock.t += 3.1
    assert not d.is_held("ola")


def test_own_words_in_own_language_lift_the_hold_at_once():
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[:9])
    assert d.is_held("ola")
    d.note_input("ola", "Czekaj, poczekajcie chwilę, muszę zadzwonić", "pl")
    assert not d.is_held("ola")
    # While she keeps talking, overheard words don't silence her again.
    d.note_input("ian", " ".join(ES_WORDS[9:12]), "es")
    d.note_input("ola", " ".join(ES_WORDS[9:12]), "es")
    assert not d.is_held("ola")


def test_overheard_words_labelled_in_the_wrong_language_do_not_lift_the_hold():
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[:9])
    d.note_input("ola", "garbled tokens from distance", "es")
    assert d.is_held("ola")


def test_a_person_who_spoke_recently_is_not_judged_on_a_few_shared_words():
    """Ola talked a lot in the last seconds; three overlapping words with Ian's
    sentence are not enough to call her mic a leak."""
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    d.note_input(
        "ola", "Wczoraj byłam u lekarza, potem poszłam na zakupy do sklepu", "pl"
    )
    clock.t += 0.5
    d.note_input("ian", " ".join(ES_WORDS[:6]), "es")
    d.note_input("ola", " ".join(ES_WORDS[:3]), "es")
    assert not d.is_held("ola")


def test_a_soft_voice_answering_is_not_mistaken_for_a_leak():
    """Diego's mic is always quieter than Ian's and recently overheard him.
    When Diego answers with mostly new words (one happens to repeat Ian's),
    the earlier shared words must not get his own answer muted."""
    d, clock, _held = detector(levels={"ian": -24.0, "diego": -41.0}, hold_sec=3.0)
    d.set_declared("ian", "es")
    d.set_declared("diego", "es")
    interleave(d, clock, "ian", "es", "diego", "es", ES_WORDS[:9])
    assert d.is_held("diego")
    clock.t += 3.5
    assert not d.is_held("diego")
    d.note_input("diego", "prefiero quedarme en casa tranquilo", "es")
    assert not d.is_held("diego")


def _held_by_language(levels=None):
    d, clock, held = detector(levels=levels or {"ian": -15.0, "ola": -36.0})
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS[:9])
    assert d.is_held("ola")
    return d, clock, held


def frames(d, clock, seconds, **levels):
    """Feed 10 ms frames of the given dBFS per mic, advancing the clock."""
    for _ in range(int(seconds * 100)):
        for who, db in levels.items():
            d.note_level(who, db, clock.t)
        clock.t += 0.01


def test_a_short_interjection_lifts_the_mute_and_its_translation_gets_through():
    """Live 3-language simulation 2026-11-17: a 2 s Polish "Co?! Serio?!"
    over an English monologue was muted with the overheard voice. Too few
    words to recognise; her voice, ~20 dB above the overheard one, is not."""
    d, clock, _held = _held_by_language()
    frames(d, clock, 0.3, ian=-15.0, ola=-14.0)  # Ola speaks up
    assert not d.is_held("ola")
    assert d.speaking_own("ola")
    # Her translation comes out seconds later: still protected, even though
    # the overheard sentence goes on.
    frames(d, clock, 3.5, ian=-15.0, ola=-36.0)
    d.note_input("ian", " ".join(ES_WORDS[9:12]), "es")
    d.note_input("ola", " ".join(ES_WORDS[9:12]), "es")
    assert d.speaking_own("ola") and not d.is_held("ola")
    # Once her voice has been gone that long, overheard words mute again.
    frames(d, clock, 1.5, ian=-15.0, ola=-36.0)
    d.note_input("ian", "caminamos por el parque grande todos juntos", "es")
    d.note_input("ola", "caminamos por el parque grande todos juntos", "es")
    assert not d.speaking_own("ola") and d.is_held("ola")


def test_after_an_interjection_the_mute_returns_if_the_other_person_is_still_talking():
    d, clock, held = _held_by_language()
    frames(d, clock, 0.5, ian=-15.0, ola=-14.0)  # Ola's interjection
    assert not d.is_held("ola")
    frames(d, clock, 4.4, ian=-15.0, ola=-36.0)  # her translation's lag window
    assert not d.is_held("ola")
    frames(d, clock, 0.3, ian=-15.0, ola=-36.0)  # grace over, Ian still talking
    assert d.is_held("ola")
    assert held == ["ola", "ola"]  # captions/queued audio cleared again


def test_after_an_interjection_nothing_is_muted_if_the_other_person_stopped():
    d, clock, _held = _held_by_language()
    frames(d, clock, 0.5, ian=-15.0, ola=-14.0)
    frames(d, clock, 5.5, ian=-60.0, ola=-55.0)  # Ian went quiet too
    assert not d.is_held("ola")


def test_a_pause_between_sentences_does_not_let_the_next_one_through():
    d, clock, held = _held_by_language()
    frames(d, clock, 4.0, ian=-15.0, ola=-36.0)
    frames(d, clock, 2.0, ian=-60.0, ola=-55.0)  # Ian pauses
    assert not d.is_held("ola")
    frames(d, clock, 0.1, ian=-15.0, ola=-36.0)  # and goes on
    assert d.is_held("ola")
    assert held == ["ola", "ola"]  # queued audio/captions cleared again


def test_the_memory_of_whom_a_mic_overheard_fades():
    d, clock, _held = _held_by_language()
    # The hold runs out (4 s) and is remembered for 8 s more; then it fades.
    frames(d, clock, 12.5, ian=-60.0, ola=-55.0)  # long silence
    frames(d, clock, 0.5, ian=-15.0, ola=-36.0)  # Ian talks again much later
    assert not d.is_held("ola")  # needs fresh evidence (shared words) first


def test_while_held_the_overheard_voice_is_kept_from_the_provider_but_the_owner_is_not():
    """Owner's 30-min session: fine at first, confused later. The provider's
    memory filled up with the neighbour's voice; now it never hears it."""
    d, clock, _held = _held_by_language()
    assert d.withhold("ola", -36.0)  # the overheard copy
    assert not d.withhold("ola", -14.0)  # her own voice goes through at once
    d2, _clock2, _ = detector()
    assert not d2.withhold("ola", -36.0)  # nobody held: nothing withheld
    frames(d, clock, 6.0, ian=-60.0, ola=-55.0)  # Ian stopped long ago
    assert not d.withhold("ola", -36.0)


def test_holds_and_lifts_are_reported_as_numbers_only():
    seen: list[tuple[str, str, dict]] = []
    d, clock, _held = _held_by_language()
    d.on_event = lambda kind, who, data: seen.append((kind, who, data))
    frames(d, clock, 0.3, ian=-15.0, ola=-14.0)  # Ola speaks up: lift
    d.forget("ola")
    kinds = [k for k, _, _ in seen]
    assert kinds == ["crosstalk_lift", "crosstalk_summary"]
    assert seen[0][2] == {"why": "own_voice"}
    assert all(
        isinstance(v, (int, float, str, bool))
        for _, _, data in seen
        for v in data.values()
    )


def test_the_mute_lasts_while_the_overheard_person_keeps_talking():
    """Even when the provider mis-transcribes the far copy (no shared words)."""
    d, clock, _held = _held_by_language()
    start = clock.t
    frames(d, clock, 9.0, ian=-15.0, ola=-36.0)  # no transcripts at all
    assert d.is_held("ola"), "hold should outlive hold_sec while Ian talks"
    frames(d, clock, 2.5, ian=-60.0, ola=-55.0)  # Ian stops
    assert not d.is_held("ola")
    assert clock.t - start > 11


def test_someone_leaning_closer_is_not_the_owner_speaking():
    d, clock, _held = _held_by_language()
    # The overheard voice gets 10.5 dB louder on Ola's mic (above the plain
    # +10 dB margin) but stays >10 dB below Ian's own near-mic level (-15).
    frames(d, clock, 1.0, ian=-15.0, ola=-25.5)
    assert d.is_held("ola") and not d.speaking_own("ola")


def test_forgetting_a_person_clears_their_state_and_logs_counts_only(caplog):
    d, clock, _held = detector()
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    with caplog.at_level(logging.DEBUG, logger="translator.crosstalk"):
        interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS)
        d.forget("ola")
    assert not d.is_held("ola")
    text = caplog.text.lower()
    assert "muted 1 times" in text
    for w in ("empanadas", "manana", "madre", "parque"):
        assert w not in text  # never log what people said


def test_disabled_detector_does_nothing():
    d, clock, held = detector(enabled=False)
    d.set_declared("ian", "es")
    d.set_declared("ola", "pl")
    interleave(d, clock, "ian", "es", "ola", "es", ES_WORDS)
    assert held == [] and not d.is_held("ola")

"""Third line of defence against same-room bleed: the same words on two mics.

Second real two-phone session (2026-11-17): the bleed guard's loudness match
(audio.py) caught 0 s, yet the provider kept transcribing the other person on
each mic (Polish 58x on a Spanish speaker's mic). Room reverb, browser noise
suppression and the headsets' own processing reshape the far voice, so its
loudness pattern no longer tracks the near copy. Its WORDS survive.

Every speaker's provider stream already returns an input transcript about once
a second. When two mics produce the same content words within a few seconds,
one of them is hearing the other. Which one leaks:

  1. language: the mic labelled in its owner's declared language is the source;
     the one labelled in some other language is the leak;
  2. otherwise loudness: the source's mic is >= `level_margin_db` louder over
     the last few seconds;
  3. otherwise nothing happens (fail open: never silence a real speaker on a
     guess — e.g. two people repeating the same phrase are both loud).

The leaking speaker's translations are muted for `hold_sec` (refreshed while
the match continues) and their captions already on screen are retracted. A
chunk of their own words, in their own language, lifts the hold at once.

This matters most at tables with three languages: a Polish speaker's mic
hearing Spanish is muted for the Spanish listener by the same-language rule,
but without this it would still be re-voiced into English for a third person.

Privacy: content words are kept in memory for `window_sec` only, folded and
lower-cased, and never logged; logs carry counts and decibels.
"""

from __future__ import annotations

import functools
import logging
import os
import re
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

logger = logging.getLogger("translator.crosstalk")
if os.environ.get("CROSSTALK_DEBUG") == "1":
    # Per-chunk match counts (never words), for tuning on a local stack.
    logger.setLevel(logging.DEBUG)

# The commonest function words (3+ letters) of the table's three languages,
# accent-folded: shared filler must not make two unrelated sentences "match".
_FILLER = """
    the and that this with for you are was but not have has had what all they she
    his her its our can will just yes about from there them then when which would
    could should been were your like okay yeah well also some into out get got
    que los las del por con una uno unos unas para como pero mas este esta esto
    eso esa ese estos estas muy sus les nos hay fue ser sin sobre tambien cuando
    donde porque todo todos toda todas bien asi aqui ahi algo nada tiene tengo
    nie sie jak ale tak jest czy ten tej tego tym tez juz tylko byl bylo byla mnie
    mam ich jego jej dla przez przy oraz albo jako wiec kiedy gdzie moze tam tutaj
    jestem jestes nam wam ktory ktora ktore
"""
STOPWORDS = frozenset(_FILLER.split())

_WORD = re.compile(r"[a-z0-9]+")


LATIN_LANGS = frozenset({"en", "pl", "es"})


def foreign_script(text: str) -> bool:
    """Mostly letters outside the Latin alphabet (e.g. Cyrillic). None of the
    table's languages is written that way: a far copy of a Polish voice came
    back labelled 'ru' and spelled in Cyrillic (live simulation 2026-11-17)."""
    latin = other = 0
    for ch in unicodedata.normalize("NFKD", text.lower()):
        if "a" <= ch <= "z":
            latin += 1
        elif ch.isalpha():
            other += 1
    return other >= 6 and other > 2 * latin


def content_words(text: str) -> list[str]:
    """Lower-case, accent-folded words of 3+ letters that are not filler."""
    s = unicodedata.normalize("NFKD", text.lower().replace("ł", "l"))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return [w for w in _WORD.findall(s) if len(w) >= 3 and w not in STOPWORDS]


@functools.lru_cache(maxsize=8192)
def same_word(a: str, b: str) -> bool:
    """Equal, the same long stem ('rozmawiamy' ~ 'rozmawiac'), or one or two
    letters off ('empanadas' ~ 'empanada', 'comer' ~ 'comen'): the far copy of
    a voice is transcribed less cleanly than the near one."""
    if a == b:
        return True
    if len(a) >= 5 and len(b) >= 5 and a[:5] == b[:5]:
        return True
    if len(a) < 4 or len(b) < 4 or abs(len(a) - len(b)) > 2 or a[:2] != b[:2]:
        return False
    return _edits(a, b) <= (1 if min(len(a), len(b)) <= 6 else 2)


def _edits(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def common_in_order(a: list[str], b: list[str]) -> int:
    """Longest common subsequence length under `same_word`."""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0] * (len(b) + 1)
        for j, y in enumerate(b, 1):
            cur[j] = prev[j - 1] + 1 if same_word(x, y) else max(prev[j], cur[j - 1])
        prev = cur
    return prev[-1]


@dataclass
class _Word:
    ts: float
    word: str


@dataclass
class _Mic:
    declared: str = ""  # en | pl | es | auto | "" (unknown)
    words: deque[_Word] = field(default_factory=deque)
    label: str | None = None  # provider's latest input-language label
    label_ts: float = 0.0
    hold_until: float = 0.0
    own_until: float = 0.0
    hearing: str | None = None
    resume_hearing: str | None = None  # whom they were overhearing until a pause
    resume_until: float = 0.0
    # Loudness references measured when a hold is decided (dBFS, 80th pct):
    # how loud the overheard voice is on THIS mic, and (as a source) how loud
    # this mic's owner is when they talk.
    leak_db: float | None = None
    hear_db: float | None = None  # how loud the overheard person is on THEIR mic
    voice_ref_db: float | None = None
    last_voice_ts: float = -1e9
    own_score: float = 0.0
    # Counts only (no content), logged when the person leaves.
    holds: int = 0
    by_language: int = 0
    by_level: int = 0
    undecided: int = 0
    lifted_by_voice: int = 0
    resumes: int = 0


LevelFn = Callable[[str, float], float | None]  # (identity, since) -> dBFS or None
HoldFn = Callable[[str], None]  # a speaker just started leaking


class CrossTalkDetector:
    def __init__(
        self,
        *,
        enabled: bool = True,
        window_sec: float = 6.0,
        min_words: int = 3,
        min_share: float = 0.3,
        hold_sec: float = 4.0,
        level_window_sec: float = 3.0,
        level_margin_db: float = 6.0,
        own_words: int = 2,
        own_grace_sec: float = 4.5,
        own_margin_db: float = 10.0,
        resume_sec: float = 8.0,
        level_fn: LevelFn | None = None,
        on_hold: HoldFn | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.enabled = enabled
        self.window_sec = window_sec
        self.min_words = min_words
        self.min_share = min_share
        self.hold_sec = hold_sec
        self.level_window_sec = level_window_sec
        self.level_margin_db = level_margin_db
        self.own_words = own_words
        # Translations lag speech by 3-5 s: an interjection's translation comes
        # out that long after the words, so their own voice protects their
        # stream for this long after it was last heard.
        self.own_grace_sec = own_grace_sec
        self.own_margin_db = own_margin_db
        self.resume_sec = resume_sec
        self.level_fn = level_fn
        self.on_hold = on_hold
        self._clock = clock
        self._mics: dict[str, _Mic] = {}

    # --- bookkeeping --------------------------------------------------------

    def set_declared(self, identity: str, speak_lang: str) -> None:
        self._mics.setdefault(identity, _Mic()).declared = speak_lang

    def forget(self, identity: str) -> None:
        mic = self._mics.pop(identity, None)
        if mic is not None and (mic.holds or mic.undecided):
            logger.info(
                "crosstalk %s: muted %d times as another person's voice "
                "(by language %d, by loudness %d), own voice lifted it %d times, "
                "resumed after a pause %d times, %d same-word matches undecided",
                identity[:8],
                mic.holds,
                mic.by_language,
                mic.by_level,
                mic.lifted_by_voice,
                mic.resumes,
                mic.undecided,
            )

    def is_held(self, identity: str, now: float | None = None) -> bool:
        mic = self._mics.get(identity)
        if mic is None or not self.enabled:
            return False
        return (self._clock() if now is None else now) < mic.hold_until

    def hearing(self, identity: str) -> str | None:
        """Whom this mic is currently hearing (while held)."""
        mic = self._mics.get(identity)
        return mic.hearing if mic is not None and self.is_held(identity) else None

    def speaking_own(self, identity: str) -> bool:
        """Their own words were just heard (in their own language)."""
        mic = self._mics.get(identity)
        return mic is not None and self._clock() < mic.own_until

    # --- input -----------------------------------------------------------------

    def note_input(self, identity: str, text: str, lang: str | None) -> None:
        """One input-transcript chunk from `identity`'s provider stream."""
        if not self.enabled:
            return
        now = self._clock()
        mic = self._mics.setdefault(identity, _Mic())
        if lang:
            mic.label = lang.split("-")[0].lower()
            mic.label_ts = now
        if mic.declared in LATIN_LANGS and foreign_script(text):
            self._foreign_script_chunk(identity, now)
            return
        new = content_words(text)
        for w in new:
            mic.words.append(_Word(now, w))
        for m in self._mics.values():
            while m.words and now - m.words[0].ts > self.window_sec:
                m.words.popleft()
        if not new:
            return

        mine = [w.word for w in mic.words]
        matches: list[tuple[str, int]] = []
        unmatched = len(new)
        diag: list[str] = []
        for other_id, other in self._mics.items():
            if other_id == identity or not other.words:
                continue
            theirs = [w.word for w in other.words]
            new_hits = sum(1 for w in new if any(same_word(w, t) for t in theirs))
            unmatched = min(unmatched, len(new) - new_hits)
            if new_hits == 0 or new_hits * 2 < len(new):
                diag.append(f"{other_id[:8]}:{new_hits}/{len(new)}")
                continue  # this chunk is not (mostly) their words
            n = common_in_order(mine, theirs)
            diag.append(
                f"{other_id[:8]}:{new_hits}/{len(new)} seq {n}/{len(mine)}:{len(theirs)}"
            )
            if n < self.min_words or n < self.min_share * min(len(mine), len(theirs)):
                continue
            matches.append((other_id, n))
        if logger.isEnabledFor(logging.DEBUG):
            # Counts only, never the words.
            logger.debug(
                "crosstalk chunk %s label=%s fit=%s %s",
                identity[:8],
                mic.label,
                self._fits(identity, now),
                " ".join(diag),
            )

        # Judge EVERY mic with the same words, not just the closest match: with
        # three or more people, two mics overhearing the same speaker match each
        # other at least as well as they match the speaker (live 3-language
        # simulation 2026-11-17), and that pair can never be decided.
        for other_id, n in sorted(matches, key=lambda m: -m[1]):
            self._resolve(identity, other_id, n, now)
        if not matches and unmatched >= self.own_words and unmatched == len(new):
            self._own_words(identity, mic, now)

    def note_guard_leak(self, identity: str, source: str | None, ts: float) -> None:
        """The loudness guard (audio.py) flagged this frame as `source`'s voice."""
        if not self.enabled or source is None:
            return
        mic = self._mics.get(identity)
        if mic is None or source not in self._mics or ts < mic.own_until:
            return
        if ts < mic.hold_until and mic.hearing == source:
            mic.hold_until = max(mic.hold_until, ts + 0.5)
            return
        # The guard fires within a second of the other person starting: measure
        # over that second, not 3 s of mostly silence (which made the overheard
        # voice look like the owner's own and lifted the hold at once).
        lv, ls = self._levels(identity, source, ts, window=1.0)
        if not self._plausible(lv, ls):
            # A stale (sticky) guard flag while nobody is talking (live run on
            # the deployed worker: both mics at ~-68 dBFS). Acting on it set
            # silence as the "overheard voice" level, so any real overheard
            # voice then looked like the owner's own and the check went blind.
            return
        self._hold(identity, source, "guard", 0, ts, lv, ls)

    def _plausible(self, leak_db: float | None, source_db: float | None) -> bool:
        """The overheard person is clearly louder on their own mic right now."""
        return (
            leak_db is not None
            and source_db is not None
            and source_db - leak_db >= self.level_margin_db
        )

    def _foreign_script_chunk(self, identity: str, now: float) -> None:
        """No words to compare: if another mic is clearly louder right now (and
        not itself labelled as someone else's language), this one overhears it."""
        if self.level_fn is None:
            return
        since = now - self.level_window_sec
        try:
            mine = self.level_fn(identity, since)
        except Exception:  # pragma: no cover - fail open
            return
        if mine is None:
            return
        best: tuple[str, float] | None = None
        for other_id in self._mics:
            if other_id == identity or self._fits(other_id, now) is False:
                continue
            try:
                theirs = self.level_fn(other_id, since)
            except Exception:  # pragma: no cover
                theirs = None
            if theirs is not None and (best is None or theirs > best[1]):
                best = (other_id, theirs)
        if best is None or best[1] - mine < self.level_margin_db:
            self._mics[identity].undecided += 1
            return
        self._hold(identity, best[0], "script", 0, now, mine, best[1])

    # --- decisions ---------------------------------------------------------------

    def _fits(self, identity: str, now: float) -> bool | None:
        """Is this mic labelled in its owner's own language? None = can't tell."""
        mic = self._mics[identity]
        if mic.declared in ("", "auto") or mic.label is None:
            return None
        if now - mic.label_ts > self.window_sec:
            return None
        return mic.label == mic.declared

    def _levels(
        self, a: str, b: str, now: float, window: float | None = None
    ) -> tuple[float | None, float | None]:
        if self.level_fn is None:
            return None, None
        since = now - (self.level_window_sec if window is None else window)
        try:
            return self.level_fn(a, since), self.level_fn(b, since)
        except Exception:  # pragma: no cover - fail open
            return None, None

    def _resolve(self, x: str, y: str, words: int, now: float) -> None:
        fx, fy = self._fits(x, now), self._fits(y, now)
        lx, ly = self._levels(x, y, now)
        leak = source = None
        how = ""
        if fx is True and fy is False:
            leak, source, how = y, x, "language"
        elif fy is True and fx is False:
            leak, source, how = x, y, "language"
        elif lx is not None and ly is not None:
            if lx - ly >= self.level_margin_db:
                leak, source, how = y, x, "loudness"
            elif ly - lx >= self.level_margin_db:
                leak, source, how = x, y, "loudness"
        if leak is None or source is None:
            self._mics[x].undecided += 1
            logger.debug(
                "crosstalk %s~%s: %d shared words, undecided (labels fit %s/%s, levels %s/%s)",
                x[:8],
                y[:8],
                words,
                fx,
                fy,
                _db(lx),
                _db(ly),
            )
            return
        self._hold(
            leak,
            source,
            how,
            words,
            now,
            lx if leak == x else ly,
            ly if leak == x else lx,
        )

    def _hold(
        self,
        leak: str,
        source: str,
        how: str,
        words: int,
        now: float,
        leak_db: float | None,
        source_db: float | None,
    ) -> None:
        mic = self._mics[leak]
        if now < mic.own_until:
            return  # just heard saying their own words: let them talk
        started = now >= mic.hold_until
        mic.hold_until = now + self.hold_sec
        mic.hearing = source
        if self._plausible(leak_db, source_db):
            # Loudness references come only from moments when the overheard
            # person is clearly louder; a decision taken in a pause keeps the
            # previous ones.
            mic.leak_db = leak_db
            mic.hear_db = source_db
            # "Still talking" for the source = within 10 dB of how loud they were.
            self._mics[source].voice_ref_db = source_db - 10.0  # type: ignore[operator]
        if how == "language":
            mic.by_language += 1
        else:
            mic.by_level += 1
        if not started:
            return
        mic.holds += 1
        logger.info(
            "crosstalk %s hears %s (%d shared words, by %s; levels %s vs %s dBFS): "
            "muting its translations",
            leak[:8],
            source[:8],
            words,
            how,
            _db(leak_db),
            _db(source_db),
        )
        if self.on_hold is not None:
            try:
                self.on_hold(leak)
            except Exception:  # pragma: no cover - best effort
                logger.exception("crosstalk hold callback failed")

    def note_level(self, identity: str, level_db: float, ts: float) -> None:
        """One 10 ms frame's loudness for `identity`'s mic.

        Once the words have shown that this mic overhears someone, loudness
        does the rest, frame by frame:
          * its owner's voice is clearly louder (`own_margin_db`) than the
            overheard voice was: they are talking, so their translations go
            through, for `own_grace_sec` after their voice was last heard
            (an interjection's translation comes out seconds later);
          * otherwise the hold is kept while the overheard person is still
            talking, even through stretches the provider mis-transcribes."""
        mic = self._mics.get(identity)
        if mic is None or not self.enabled:
            return
        if mic.voice_ref_db is not None and level_db >= mic.voice_ref_db:
            mic.last_voice_ts = ts
        if mic.leak_db is None:
            return
        # Their own voice: clearly above the overheard copy, and about as loud as
        # a near voice (the overheard person on their own mic), so someone
        # leaning closer does not count as the owner talking.
        own_threshold = mic.leak_db + self.own_margin_db
        if mic.hear_db is not None:
            own_threshold = max(own_threshold, mic.hear_db - self.own_margin_db)
        loud = level_db >= own_threshold
        if loud:
            mic.own_score = min(mic.own_score + 1.0, 30.0)
        else:
            mic.own_score = max(mic.own_score - 0.5, 0.0)
        if loud and mic.own_score >= 10.0:  # ~0.1-0.2 s of a clearly louder voice
            mic.own_until = max(mic.own_until, ts + self.own_grace_sec)
            if ts < mic.hold_until:
                mic.lifted_by_voice += 1
                self._lift(identity, mic, "own voice")
            return
        if ts < mic.own_until:
            return
        if mic.hearing is None:
            # Not muted, but recently overhearing someone (they paused between
            # sentences, or this mic's owner spoke up). If that person talks
            # again while the owner stays quiet, mute again at once instead of
            # waiting for fresh shared words (live simulation: a few seconds of
            # the overheard voice got through after every pause/interjection).
            src_id = mic.resume_hearing
            if src_id is None:
                return
            if ts >= mic.resume_until:
                mic.resume_hearing = None
                return
            src = self._mics.get(src_id)
            if src is not None and ts - src.last_voice_ts <= 0.3:
                mic.resume_hearing = None
                mic.hearing = src_id
                mic.hold_until = ts + 0.5
                mic.resumes += 1
                logger.debug("crosstalk %s hears %s again", identity[:8], src_id[:8])
                if self.on_hold is not None:
                    try:
                        self.on_hold(identity)
                    except Exception:  # pragma: no cover - best effort
                        logger.exception("crosstalk hold callback failed")
            return
        if ts >= mic.hold_until - 0.2:
            src = self._mics.get(mic.hearing)
            if src is not None and ts - src.last_voice_ts <= 1.0:
                mic.hold_until = max(mic.hold_until, ts + 0.5)
            elif ts >= mic.hold_until:
                self._remember(mic, ts)  # the overheard person paused or stopped

    def _remember(self, mic: _Mic, ts: float) -> None:
        mic.resume_hearing = mic.hearing
        mic.resume_until = ts + self.resume_sec
        mic.hearing = None

    def _lift(self, identity: str, mic: _Mic, why: str) -> None:
        self._remember(mic, max(self._clock(), mic.own_until))
        mic.hold_until = 0.0
        logger.info("crosstalk %s: %s again, translations back on", identity[:8], why)

    def _own_words(self, identity: str, mic: _Mic, now: float) -> None:
        if self._fits(identity, now) is False:
            return  # labelled as someone else's language: not their own words
        mic.own_until = max(mic.own_until, now + self.own_grace_sec)
        if now < mic.hold_until:
            self._lift(identity, mic, "own words")


def _db(v: float | None) -> str:
    return "?" if v is None else f"{v:.1f}"

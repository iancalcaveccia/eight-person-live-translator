"""Score a long-session run (scripts/longsim.ps1) cycle by cycle.

    python scripts/long_session_score.py ../docs/results/2026-11-17-long-session-old.json \
        ../docs/results/2026-11-18-long-session-new.json

Similarity to cycle 1 alone misleads: a provider stream repeats its own
earlier wording of the same audio word for word, and a fresh stream words it
anew even when correct. So each translation (pair, cycle) is also checked
against the script itself (both people tell the same story, see FACTS):

  facts     how many of the story's 15 facts came through
  errors    wrong renderings seen in runs ("Iga" for Ian, "aprecio la
            harina", "talón de Aquiles", "Nazywam się Cześć", …); the list
            only knows errors seen so far, so read new runs' captions too
  shortest  words relative to the same utterance in cycle 1 (cut short < 0.7)
  sim-to-1  the test's own similarity number

Cycles not published in real time (ratio > 1.1) are marked and left out of
the half-run averages.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from statistics import mean

NAME_OK = re.compile(r"\b(g?ian\s?-?luca|ianluka|ian\s?luka)\b", re.I)


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower().replace("ł", "l"))
    return "".join(c for c in s if not unicodedata.combining(c))


def words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", fold(s))


def dup_count(text: str, window: int = 8) -> int:
    """Repeated words/bigrams close together: consecutive duplicates
    ("hola hola") and a bigram seen again within `window` words."""
    w = words(text)
    n = 0
    for i in range(1, len(w)):
        if w[i] == w[i - 1] and len(w[i]) > 2:
            n += 1
    seen: dict[tuple[str, str], int] = {}
    for i in range(len(w) - 1):
        bg = (w[i], w[i + 1])
        if bg in seen and i - seen[bg] <= window:
            n += 1
        seen[bg] = i
    return n


# Facts the script carries (both people tell the same story), checked on the
# folded text, and wrong renderings seen in runs. Polish output → es->pl,
# Spanish output → pl->es. The baker-topic slot is left out: the Polish clip
# itself is ambiguous there (pizza / fútbol across clean runs).
FACTS = {
    "pl->es": [
        r"\bian\s?luc?k?a\b",
        r"argentina",
        r"cracovia",
        r"toda (la|mi) familia",
        r"departamento",
        r"vecinos",
        r"panaderia de la esquina",
        r"mejor pan",
        r"todas las mananas|cada manana|todos los dias",
        r"dos hogazas",
        r"clima|tiempo",
        r"precio de la harina|el precio|los precios",
        r"\bmama\b|\bmadre\b",
        r"buenos aires",
        r"cenar|cenamos|ceno\b|cena\b",
    ],
    "es->pl": [
        r"ian\s?luca|gianluca|ianluca",
        r"argentyn",
        r"krakow",
        r"cala rodzina",
        r"mieszkanie",
        r"sasiedzi",
        r"piekarnia (z |na )?(tej |tego )?rogu",
        r"najlepsz\w* (chleb|pieczywo)",
        r"(dzis|dzisiaj) wieczorem|dzisiejszej nocy",
        r"poranki|ranka|ranki",
        r"zjemy|kolacj",
        r"opowiedziec",
        r"historie",
        r"jestem z",
        r"mieszkam w",
    ],
}
ERRORS = {
    "pl->es": [
        r"\biga\b",
        r"\bjan luka\b",
        r"talon de aquiles",
        r"aprecio la harina",
        r"horno de lena",
        r"precio de los monos",
        r"\bhola\W+hola\b",
    ],
    "es->pl": [
        r"nazywam sie czesc",
        r"czesc\W+czesc",
        r"najlepsz\w* pizz",
        r"wszystkie kazdego",
        r"z jest na rogu",
        r"\bdzis\s+z\b",
        r"czesc\W+nazywam\s*$",
    ],
}


def facts(pair: str, text: str) -> tuple[int, int, list[str]]:
    t = fold(text)
    t = re.sub(r"\s+", " ", t)
    have = sum(bool(re.search(p, t)) for p in FACTS.get(pair, []))
    wrong = [p for p in ERRORS.get(pair, []) if re.search(p, t)]
    return have, len(FACTS.get(pair, [])), wrong


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def report(path: str) -> None:
    run = load(path)
    ratio = {c["cycle"]: c.get("publish_ratio") or 1.0 for c in run["cycles"]}
    minute = {c["cycle"]: c.get("minute") for c in run["cycles"]}
    sim = {c["cycle"]: c.get("similarity_to_first") for c in run["cycles"]}
    first_len: dict[tuple[str, int], int] = {}
    rows: dict[int, list[dict]] = {}
    for e in run["expected"]:
        text = e.get("text") or ""
        key = (e["pair"], e["utterance"])
        if e["cycle"] == 1:
            first_len[key] = max(1, len(words(text)))
        have, of, wrong = facts(e["pair"], text)
        rows.setdefault(e["cycle"], []).append(
            {
                "pair": e["pair"],
                "facts": have,
                "of": of,
                "wrong": wrong,
                "name": bool(NAME_OK.search(fold(text))),
                "dups": dup_count(text),
                "len": len(words(text)) / first_len.get(key, max(1, len(words(text)))),
                "heard": e.get("first_audio_s") is not None,
            }
        )
    print(f"\n== {path}")
    print(" cycle  min  ratio  facts    errors  shortest  sim-to-1")
    halves: dict[str, list[dict]] = {"first": [], "second": []}
    n = len(rows)
    for c in sorted(rows):
        r = rows[c]
        bad = ratio[c] > 1.1
        have = sum(x["facts"] for x in r)
        of = sum(x["of"] for x in r)
        wrong = [w for x in r for w in x["wrong"]]
        short = min(x["len"] for x in r)
        print(
            f"  {c:>3} {minute[c]:>5} {ratio[c]:>5}  {have:>2}/{of}   {len(wrong):>3}     {short:>5.2f}"
            f"    {sim[c] if sim[c] is not None else '-':<6}"
            f"{'  (not real time: ignored)' if bad else ''}  {' | '.join(wrong)}"
        )
        if not bad:
            halves["first" if c <= n / 2 else "second"].append(
                {"have": have, "of": of, "wrong": len(wrong), "sim": sim[c]}
            )
    for h, v in halves.items():
        if not v:
            continue
        sims = [x["sim"] for x in v if x["sim"] is not None]
        print(
            f"  {h} half ({len(v)} cycles): facts right {sum(x['have'] for x in v) / sum(x['of'] for x in v):.1%},"
            f" known errors {sum(x['wrong'] for x in v)} ({sum(x['wrong'] for x in v) / len(v):.2f} per cycle),"
            f" similarity to cycle 1 {mean(sims) if sims else float('nan'):.3f}"
        )


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)

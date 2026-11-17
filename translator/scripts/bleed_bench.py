"""Offline bench for the worker's bleed handling (no network, no cost).

Builds the same synthetic table as table_sim.py (own voice + other people's
voices leaking in at --bleed-db with room reverb + noise floor), then runs the
worker's real EnergyVad + BleedGuard + InputGate frame by frame, with each
person's frames arriving with a different network skew, and reports per
person:

  leak_sent_s   seconds of audio the gate would SEND to the provider while
                that person was not talking (only someone else's voice)
                -> this is what becomes "phantom" translations;
  own_flagged_s seconds of that person's own speech flagged as bleed
                (false flags; the gate pre-roll recovers short ones).

    uv run python scripts/bleed_bench.py --clip es=a.wav --clip pl=b.wav
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE))

import table_sim  # noqa: E402
from latency_probe import FRAME, RATE, load_wav_48k_mono  # noqa: E402

from audio import (  # noqa: E402
    BleedGuard,
    EnergyVad,
    InputChunk,
    InputGate,
    Subscription,
    energy_dbfs,
)
from config import Settings  # noqa: E402

COUPLE = [
    "0:es:3:30",
    "1:pl:40:30",
    "0:es:77:20",
    "1:pl:85:2",
    "0:es:105:12",
    "1:pl:105:12",
]


def make_guard(settings: Settings) -> BleedGuard:
    return BleedGuard(
        enabled=True,
        corr_threshold=settings.bleed_corr_threshold,
        level_diff_db=settings.bleed_level_diff_db,
        window_ms=settings.bleed_window_ms,
        max_lag_ms=settings.bleed_max_lag_ms,
        max_offset_ms=settings.bleed_max_offset_ms,
        persist_evals=settings.bleed_persist_evals,
        corr_relaxed=settings.bleed_corr_relaxed,
        bounded_ratio=settings.bleed_bounded_ratio,
        bound_margin_db=settings.bleed_bound_margin_db,
        release_evals=settings.bleed_release_evals,
        own_voice_margin_db=settings.bleed_own_voice_margin_db,
        own_voice_rise_db=settings.bleed_own_voice_rise_db,
        own_voice_hold_ms=settings.bleed_own_voice_hold_ms,
        own_voice_persist_ms=settings.bleed_own_voice_persist_ms,
    )


def run_bench(
    mics, spans, settings: Settings, skews_ms, gate_cls=InputGate
) -> list[dict]:
    n_people = len(mics)
    n = len(mics[0]) // FRAME
    guard = make_guard(settings)
    vads = [
        EnergyVad(
            threshold_db=settings.vad_threshold_db, min_dbfs=settings.vad_min_dbfs
        )
        for _ in mics
    ]
    events = sorted(
        (i * 0.01 + skews_ms[p] / 1000.0, p, i)
        for p in range(n_people)
        for i in range(n)
    )
    vad = np.zeros((n_people, n), bool)
    flag = np.zeros((n_people, n), bool)
    for t, p, i in events:
        frame = mics[p][i * FRAME : (i + 1) * FRAME]
        lvl = energy_dbfs(frame)
        v = vads[p].update(lvl)
        guard.update(str(p), lvl, t)
        vad[p, i] = v
        flag[p, i] = guard.is_bleed(str(p), t) if v else False
    speech = vad & ~flag

    out = []
    per_chunk = settings.gemini_chunk_ms // 10
    for p in range(n_people):
        own = np.zeros(n, bool)
        others = np.zeros(n, bool)
        for s in spans:
            seg = slice(int((s["start"] - 0.3) * 100), int(s["end"] * 100) + 30)
            if s["who"] == p:
                own[seg] = True
            else:
                others[seg] = True
        gate = gate_cls(
            enabled=True,
            pre_roll_ms=settings.gate_pre_roll_ms,
            hangover_ms=settings.gate_hangover_ms,
            chunk_ms=settings.gemini_chunk_ms,
        )
        # Chunk exactly like production (Subscription), then gate.
        sub = Subscription(
            sample_rate=RATE, chunk_ms=settings.gemini_chunk_ms, max_queue=100000
        )
        silent = bytes(FRAME * 2)
        for i in range(n):
            sub.feed(
                silent, speech=bool(speech[p, i]), bleed=bool(flag[p, i]), ts=i / 100.0
            )
        sent = np.zeros(n, bool)
        while not sub.queue.empty():
            chunk: InputChunk = sub.queue.get_nowait()
            for ch in gate.process(chunk):
                k = round(ch.ts * 100)
                sent[k : k + per_chunk] = True
        out.append(
            {
                "person": p,
                # Sent while someone else talked and this person did not
                # (their own hangover after speaking is not a leak).
                "leak_sent_s": round(float((sent & others & ~own).sum()) / 100, 1),
                "others_talking_s": round(float((others & ~own).sum()) / 100, 1),
                "own_flagged_s": round(float((flag[p] & own & vad[p]).sum()) / 100, 1),
                # Own speech never sent at all (the pre-roll recovers short flags).
                "own_lost_s": round(float((vad[p] & own & ~sent).sum()) / 100, 1),
                "own_speech_s": round(float((vad[p] & own).sum()) / 100, 1),
            }
        )
    return out


def build(args, bleed_db: float, reverb: float, schedule: list[str]):
    clips = {
        k: load_wav_48k_mono(Path(v)) for k, v in (c.split("=", 1) for c in args.clip)
    }
    people = table_sim.parse_people(args.people)
    utts = []
    for spec in schedule:
        who, clip, start, *length = spec.split(":")
        utts.append(
            table_sim.Utterance(
                int(who), clip, float(start), float(length[0]) if length else None
            )
        )
    total = max(u.start + (u.length or len(clips[u.clip]) / RATE) for u in utts) + 2
    orig = table_sim.room_impulse

    def impulse(delay_ms, rt60=0.4, seed=0):
        h = orig(delay_ms, rt60, seed)
        d = int(RATE * delay_ms / 1000)
        h[d + 1 :] *= reverb / 0.08
        return h

    table_sim.room_impulse = impulse
    try:
        spans = table_sim.build_mics(people, utts, clips, bleed_db, total)
    finally:
        table_sim.room_impulse = orig
    return [p.mic for p in people], spans


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--clip", action="append", required=True)
    p.add_argument("--people", default="Ian:es:es,Partner:pl:pl")
    p.add_argument("--say", action="append")
    p.add_argument("--bleed-db", type=float, action="append")
    p.add_argument(
        "--reverb", type=float, action="append", help="tail gain; 0.08 = harsh"
    )
    p.add_argument("--skew-ms", default="0,60")
    p.add_argument("--out")
    args = p.parse_args()
    settings = Settings()
    skews = [float(x) for x in args.skew_ms.split(",")]
    rows = []
    for reverb in args.reverb or [0.08, 0.03]:
        for bleed in args.bleed_db or [-28.0, -20.0, -12.0]:
            mics, spans = build(args, bleed, reverb, args.say or COUPLE)
            res = run_bench(mics, spans, settings, skews[: len(mics)] + [0] * len(mics))
            rows.append({"bleed_db": bleed, "reverb": reverb, "people": res})
            print(
                f"bleed {bleed:>5} dB reverb {reverb:.2f}: "
                + " | ".join(
                    f"p{r['person']} leak {r['leak_sent_s']:>5}/{r['others_talking_s']}s own-flagged "
                    f"{r['own_flagged_s']:>4}/{r['own_speech_s']}s lost {r['own_lost_s']}s"
                    for r in res
                ),
                flush=True,
            )
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

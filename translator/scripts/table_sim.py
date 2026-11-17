"""Simulate people talking at one table, through the DEPLOYED app, with acoustic bleed.

Every simulated person joins the real web app like a phone (host creates the
gathering, the others use the invite link, media tokens come from the API), so
the control plane, admission, LiveKit Cloud and the deployed worker with the
real provider are all in the path.

Each person's microphone = their own clips + every other person's clips
attenuated by --bleed-db, delayed by distance and smeared by a synthetic room
reverb (RT60 ~0.4 s) + a -60 dBFS noise floor. That is what a headset mic hears
when someone else talks across the table.

Measured per listener, on what they would actually hear (tx:<speaker>:<their
language>):
  * expected translations: first audible audio after the speaker's onset, and
    whether it began before the speaker stopped;
  * phantom audio: translated audio on a person's track while that person was
    NOT talking (= their mic picked up someone else and it got translated, the
    "neighbour translated twice" failure).

    uv run python scripts/table_sim.py --app-url https://<app>.vercel.app \
        --people "Ian:es:es:es-AR,Kasia:pl:pl" --bleed-db -20 \
        --clip es=clips/es.wav --clip pl=clips/pl.wav --out results/couple.json

The gathering is ended at the end (its data is deleted). Nothing is recorded.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from livekit import rtc

sys.path.insert(0, str(Path(__file__).resolve().parent))
from latency_probe import (
    FRAME,
    RATE,
    AppClient,
    app_prefs,
    frame_db,
    load_wav_48k_mono,
)

THR_DB = -45.0
TAIL_S = 8.0  # translation may trail the source by this much


@dataclass
class Person:
    name: str
    speak: str
    listen: str
    region: str = ""
    pid: str = ""
    token: str = ""
    room: rtc.Room = field(default_factory=rtc.Room)
    source: rtc.AudioSource = field(
        default_factory=lambda: rtc.AudioSource(RATE, 1, queue_size_ms=40)
    )
    rx: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    captions: list[dict] = field(default_factory=list)
    tasks: list[asyncio.Task] = field(default_factory=list)
    mic: np.ndarray | None = None


@dataclass
class Utterance:
    who: int
    clip: str
    start: float
    length: float | None = None  # seconds of the clip to use


def parse_people(spec: str) -> list[Person]:
    out = []
    for item in spec.split(","):
        parts = item.split(":")
        out.append(
            Person(parts[0], parts[1], parts[2], parts[3] if len(parts) > 3 else "")
        )
    return out


def room_impulse(delay_ms: float, rt60: float = 0.4, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(RATE * rt60)
    t = np.arange(n) / RATE
    tail = rng.normal(0, 1, n) * np.exp(-6.9 * t / rt60) * 0.08
    h = np.zeros(int(RATE * delay_ms / 1000) + n)
    d = int(RATE * delay_ms / 1000)
    h[d] = 1.0
    h[d : d + n] += tail
    return h


def fft_convolve(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    n = len(x) + len(h) - 1
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(h, size), size)[: len(x)]
    return y


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if x.size else 0.0


def speech_onset(clip: np.ndarray) -> float:
    for i in range(0, len(clip) - FRAME, FRAME):
        if frame_db(clip[i : i + FRAME]) > THR_DB:
            return i / RATE
    return 0.0


def build_mics(
    people: list[Person],
    utts: list[Utterance],
    clips: dict[str, np.ndarray],
    bleed_db: float,
    total_s: float,
) -> list[dict]:
    n = int(total_s * RATE)
    own = [np.zeros(n) for _ in people]
    bleed = [np.zeros(n) for _ in people]
    spans = []
    for k, u in enumerate(utts):
        c = clips[u.clip].astype(np.float64)
        if u.length:
            c = c[: int(u.length * RATE)]
        s = int(u.start * RATE)
        e = min(n, s + len(c))
        own[u.who][s:e] += c[: e - s]
        onset = u.start + speech_onset(clips[u.clip][: e - s].astype(np.int16))
        spans.append({"who": u.who, "start": u.start, "onset": onset, "end": e / RATE})
        for j in range(len(people)):
            if j == u.who:
                continue
            h = room_impulse(delay_ms=3.0 + 2.0 * abs(j - u.who), seed=k * 10 + j)
            wet = fft_convolve(c[: e - s], h)
            wet *= rms(c[: e - s]) * 10 ** (bleed_db / 20) / max(rms(wet), 1e-9)
            bleed[j][s:e] += wet
    rng = np.random.default_rng(42)
    for i, p in enumerate(people):
        noise = rng.normal(0, 32768 * 10 ** (-60 / 20), n)
        p.mic = np.clip(own[i] + bleed[i] + noise, -32768, 32767).astype(np.int16)
    return spans


async def join_all(args, people: list[Person]):
    clients = [AppClient(args.app_url) for _ in people]
    host = people[0]
    created = clients[0].call(
        "POST",
        "/api/gatherings",
        {
            "title": "Table simulation",
            **app_prefs(host.name, host.speak, host.listen, host.region),
        },
    )
    gid = created["gatheringId"]
    invite = created["inviteUrlPath"].split("#k=", 1)[1]
    host.pid = created["participantId"]

    def end() -> None:
        clients[0].call("POST", f"/api/gatherings/{gid}/end")

    try:
        for c, p in zip(clients[1:], people[1:], strict=True):
            j = c.call(
                "POST",
                f"/api/gatherings/{gid}/join",
                {
                    "inviteToken": invite,
                    **app_prefs(p.name, p.speak, p.listen, p.region),
                },
            )
            p.pid = j["participantId"]
        url = ""
        for c, p in zip(clients, people, strict=True):
            m = c.call("POST", f"/api/gatherings/{gid}/token")
            p.token, url = m["token"], m["serverUrl"]
    except BaseException:
        end()
        raise
    return url, end


async def connect(person: Person, url: str) -> None:
    @person.room.on("track_subscribed")
    def _sub(track, pub, _p):
        if (
            track.kind == rtc.TrackKind.KIND_AUDIO
            and pub.name.startswith("tx:")
            and pub.name.endswith(":" + person.listen)
        ):
            person.tasks.append(asyncio.create_task(listen(person, track, pub.name)))

    def _caption(reader, _sender) -> None:
        async def read() -> None:
            text = await reader.read_all()
            a = dict(reader.info.attributes or {})
            person.captions.append(
                {
                    "t": time.monotonic(),
                    "speaker": a.get("source_identity", ""),
                    "kind": a.get("kind", ""),
                    "target": a.get("target_lang", ""),
                    "seg": a.get("seg", ""),
                    "chars": len(text.strip()),
                    "retract": a.get("retract") == "true",
                }
            )

        person.tasks.append(asyncio.create_task(read()))

    person.room.register_text_stream_handler("lk.translation", _caption)
    await person.room.connect(url, person.token)
    track = rtc.LocalAudioTrack.create_audio_track("microphone", person.source)
    await person.room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )


async def listen(person: Person, track, name: str) -> None:
    stream = rtc.AudioStream.from_track(
        track=track, sample_rate=RATE, num_channels=1, frame_size_ms=10
    )
    series = person.rx.setdefault(name, [])
    async for ev in stream:
        b = np.frombuffer(bytes(ev.frame.data.cast("b")), np.int16)
        series.append((time.monotonic(), frame_db(b)))


async def publish(people: list[Person]) -> tuple[float, float]:
    t0 = time.monotonic()
    n = len(people[0].mic)
    for i in range(0, n - FRAME + 1, FRAME):
        await asyncio.gather(
            *(
                p.source.capture_frame(
                    rtc.AudioFrame(p.mic[i : i + FRAME].tobytes(), RATE, 1, FRAME)
                )
                for p in people
            )
        )
    return t0, (time.monotonic() - t0) / (n / RATE)


def loud_times(series, a: float, b: float) -> list[float]:
    return [t for t, db in series if a <= t <= b and db > THR_DB]


def analyse(people, spans, t0, wait_extra):
    expected, phantoms = [], []
    for li, lis in enumerate(people):
        for si, spk in enumerate(people):
            if si == li:
                continue
            name = f"tx:{spk.pid}:{lis.listen}"
            series = lis.rx.get(name, [])
            own = [s for s in spans if s["who"] == si]
            if spk.speak != lis.listen:
                for s in own:
                    on, end = t0 + s["onset"], t0 + s["end"]
                    hits = loud_times(series, on, end + TAIL_S)
                    expected.append(
                        {
                            "speaker": spk.name,
                            "listener": lis.name,
                            "pair": f"{spk.speak}->{lis.listen}",
                            "at_s": round(s["start"], 1),
                            "speech_s": round(s["end"] - s["onset"], 1),
                            "first_audio_s": round(hits[0] - on, 2) if hits else None,
                            "began_before_speaker_stopped": bool(
                                hits and hits[0] < end
                            ),
                            "heard_s": round(len(hits) / 100, 1),
                        }
                    )
            # Phantom: audio on spk's track while spk was not talking.
            busy = [(t0 + s["start"] - 0.3, t0 + s["end"] + TAIL_S) for s in own]
            loud = [
                t
                for t, db in series
                if db > THR_DB and not any(a <= t <= b for a, b in busy)
            ]
            segments: list[list[float]] = []
            for t in sorted(loud):
                rel = round(t - t0, 2)
                if segments and rel - segments[-1][1] <= 0.5:
                    segments[-1][1] = rel
                else:
                    segments.append([rel, rel])
            # Captions the listener's screen shows under spk's name while spk
            # was not talking (what the first real test noticed), after the
            # worker's retractions. Only counts are kept, never text.
            caps: dict[str, dict] = {}
            retracted: set[str] = set()
            for c in lis.captions:
                if not (
                    c["speaker"] == spk.pid
                    and c["kind"] == "translation"
                    and c["target"] == lis.listen
                ):
                    continue
                if c["retract"]:
                    retracted.add(c["seg"])
                    continue
                seg = caps.setdefault(c["seg"], {"t": c["t"], "chars": 0})
                seg["chars"] += c["chars"]
            ghost = [
                s
                for k, s in caps.items()
                if k not in retracted
                and s["chars"] > 0
                and not any(a <= s["t"] <= b for a, b in busy)
            ]
            phantoms.append(
                {
                    "track_of": spk.name,
                    "heard_by": lis.name,
                    "language": lis.listen,
                    "phantom_s": round(len(loud) / 100, 2),
                    "phantom_at_s": [f"{a:.1f}-{b:.1f}" for a, b in segments],
                    "phantom_caption_segments": len(ghost),
                    "phantom_caption_chars": sum(s["chars"] for s in ghost),
                    "phantom_caption_at_s": [round(s["t"] - t0, 1) for s in ghost],
                    "retracted_segments": len(retracted & set(caps)),
                    "subscribed": name in lis.rx,
                }
            )
    return expected, phantoms


async def run(args) -> dict:
    people = parse_people(args.people)
    clips = {
        k: load_wav_48k_mono(Path(v)) for k, v in (c.split("=", 1) for c in args.clip)
    }
    utts = []
    for spec in args.say:
        who, clip, start, *length = spec.split(":")
        utts.append(
            Utterance(
                int(who), clip, float(start), float(length[0]) if length else None
            )
        )
    total = max(u.start + (u.length or len(clips[u.clip]) / RATE) for u in utts) + 2
    spans = build_mics(people, utts, clips, args.bleed_db, total)
    # Phones deliver their mic streams with different delays (Bluetooth,
    # capture pipeline): delay each person's whole mic signal by their skew.
    skews = [float(x) for x in args.skew_ms.split(",")] if args.skew_ms else []
    for idx, ms in enumerate(skews[: len(people)]):
        k = int(RATE * ms / 1000)
        if k <= 0:
            continue
        mic = people[idx].mic
        people[idx].mic = np.concatenate([mic[:k], mic])[: len(mic)]
        for s in spans:
            if s["who"] == idx:
                for f in ("start", "onset", "end"):
                    s[f] += ms / 1000

    url, end = await join_all(args, people)
    try:
        for p in people:
            await connect(p, url)
        # Let the interpreter join and open sessions (it needs a listener first).
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if all(
                any(n.endswith(":" + p.listen) for n in p.rx)
                for p in people
                if any(q.speak != p.listen for q in people if q is not p)
            ):
                break
            await asyncio.sleep(0.2)
        await asyncio.sleep(1.0)
        t0, ratio = await publish(people)
        await asyncio.sleep(TAIL_S)
        expected, phantoms = analyse(people, spans, t0, TAIL_S)
    finally:
        for p in people:
            for t in p.tasks:
                t.cancel()
            await p.room.disconnect()
        end()

    firsts = [e["first_audio_s"] for e in expected if e["first_audio_s"] is not None]
    return {
        "date_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "app_host": args.app_url.split("//")[-1].split("/")[0],
        "people": [f"{p.name} speaks {p.speak}, hears {p.listen}" for p in people],
        "bleed_db": args.bleed_db,
        "phone_delay_ms": skews[: len(people)] if skews else None,
        "published_in_real_time": ratio <= 1.1,
        "publish_time_ratio": round(ratio, 2),
        "translations_expected": len(expected),
        "translations_heard": sum(
            1 for e in expected if e["first_audio_s"] is not None
        ),
        "all_began_before_speaker_stopped": all(
            e["began_before_speaker_stopped"] for e in expected
        ),
        "first_audio_median_s": round(float(np.median(firsts)), 2) if firsts else None,
        "first_audio_max_s": round(max(firsts), 2) if firsts else None,
        "phantom_total_s": round(sum(p["phantom_s"] for p in phantoms), 2),
        "phantom_caption_segments_total": sum(
            p["phantom_caption_segments"] for p in phantoms
        ),
        "expected": expected,
        "phantoms": phantoms,
        "host": platform.platform(),
        "note": "Synthetic voices and synthetic room bleed; not a phone/Bluetooth test.",
    }


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--app-url", required=True)
    p.add_argument(
        "--people",
        required=True,
        help="name:speak:listen[:es-region],... (first one hosts)",
    )
    p.add_argument("--clip", action="append", required=True, help="key=path.wav")
    p.add_argument(
        "--say",
        action="append",
        required=True,
        help="person_index:clip_key:start_s[:length_s]",
    )
    p.add_argument("--bleed-db", type=float, default=-20.0)
    p.add_argument(
        "--skew-ms",
        default="",
        help="per-person extra mic delay in ms, e.g. 0,250 (phones differ)",
    )
    p.add_argument("--out")
    args = p.parse_args()
    summary = asyncio.run(run(args))
    text = json.dumps(summary, indent=2, ensure_ascii=False)
    print(text)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()

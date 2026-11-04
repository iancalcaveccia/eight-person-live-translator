"""Measure real speech-to-translated-speech latency through LiveKit + a real provider.

What it does
------------
Joins a LiveKit room as two synthetic participants, publishes a WAV clip as
the speaker's microphone in real time (repeated N times with silent gaps),
subscribes as the listener to `tx:<speaker>:<listen_lang>`, and reports for
every repetition:

* first translated audio after source speech onset (listener clock),
* whether translation began BEFORE the source clip finished,
* translated speech heard before the source ended / source speech duration,
* end catch-up (last translated audio after the source ended),
* the worker's own onset->first-audio figure from `interp.events`,

plus p50/p95 across repetitions. Optionally an interjection clip from a
second speaker is published at a fixed offset to measure
interruption-onset -> first audible translation for the original speaker.

Which worker it talks to
------------------------
Tokens are minted directly with LIVEKIT_API_KEY/SECRET and dispatch the
agent named by --agent-name. The production worker admits only participants
known to the control plane, so point the probe at a worker started in
standalone mode, e.g. (PowerShell):

    $env:TRANSLATOR_AGENT_NAME="interp-probe"; $env:CONTROL_PLANE_URL=""
    uv run python src/agent.py start          # GEMINI_API_KEY etc. in .env.local

and then:

    uv run python scripts/latency_probe.py --agent-name interp-probe \
        --speaker-wav es_ar_30s.wav --speaker-lang es --listener-lang pl \
        --repeat 5 --out results/es-pl.json

Environment: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (from
translator/.env.local or the shell). Never commits or prints secrets. Audio
is not recorded unless --record-dir is given (translated audio of YOUR test
clip only).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import platform
import statistics
import sys
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc

RATE = 48000
FRAME = RATE // 100  # 10 ms


def load_wav_48k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"{path}: only 16-bit PCM WAV is supported")
        rate = w.getframerate()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype(np.int16)
    if rate != RATE:
        rs = rtc.AudioResampler(
            rate, RATE, num_channels=1, quality=rtc.AudioResamplerQuality.HIGH
        )
        out = []
        step = rate // 100
        for i in range(0, len(data), step):
            for f in rs.push(bytearray(data[i : i + step].tobytes())):
                out.append(np.frombuffer(bytes(f.data.cast("b")), dtype=np.int16))
        for f in rs.flush():
            out.append(np.frombuffer(bytes(f.data.cast("b")), dtype=np.int16))
        data = np.concatenate(out) if out else np.zeros(0, np.int16)
    return data


def frame_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -90.0
    r = float(np.sqrt(np.mean(x.astype(np.float32) ** 2)))
    return -90.0 if r <= 0 else 20 * np.log10(r / 32768)


def pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def token(
    key: str, secret: str, room: str, identity: str, speak: str, listen: str, agent: str
) -> str:
    dispatch = json.dumps(
        {"v": 1, "gatheringId": "probe", "groupId": "probe", "room": room}
    )
    return (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name(identity)
        .with_attributes(
            {
                "interp.v": "1",
                "speak_lang": speak,
                "listen_lang": listen,
                "es_region": "",
                "epoch": "1",
            }
        )
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
                can_update_own_metadata=False,
            )
        )
        .with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=agent, metadata=dispatch)],
                empty_timeout=60,
                departure_timeout=20,
                max_participants=10,
            )
        )
        .to_jwt()
    )


@dataclass
class Peer:
    identity: str
    speak: str
    listen: str
    room: rtc.Room = field(default_factory=rtc.Room)
    source: rtc.AudioSource = field(
        default_factory=lambda: rtc.AudioSource(RATE, 1, queue_size_ms=40)
    )
    rx: dict[str, list[tuple[float, float]]] = field(
        default_factory=dict
    )  # track -> (t, dB)
    rx_audio: dict[str, list[bytes]] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    tasks: list[asyncio.Task] = field(default_factory=list)
    record: bool = False

    async def join(self, url: str, tok: str) -> None:
        @self.room.on("track_subscribed")
        def _sub(track, pub, _p):
            if track.kind == rtc.TrackKind.KIND_AUDIO and pub.name.startswith("tx"):
                self.tasks.append(asyncio.create_task(self._listen(track, pub.name)))

        @self.room.on("data_received")
        def _data(pkt):
            if pkt.topic == "interp.events":
                with contextlib.suppress(Exception):
                    self.events.append({"rx": time.monotonic(), **json.loads(pkt.data)})

        await self.room.connect(url, tok)
        track = rtc.LocalAudioTrack.create_audio_track("microphone", self.source)
        await self.room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )

    async def _listen(self, track, name: str) -> None:
        stream = rtc.AudioStream.from_track(
            track=track, sample_rate=RATE, num_channels=1, frame_size_ms=10
        )
        series = self.rx.setdefault(name, [])
        audio = self.rx_audio.setdefault(name, [])
        async for ev in stream:
            b = bytes(ev.frame.data.cast("b"))
            series.append((time.monotonic(), frame_db(np.frombuffer(b, np.int16))))
            if self.record:
                audio.append(b)

    async def play(self, samples: np.ndarray) -> list[tuple[float, float]]:
        """Publish in real time (capture back-pressure paces it). Returns (t, dB) per frame."""
        out = []
        for i in range(0, len(samples) - FRAME + 1, FRAME):
            f = samples[i : i + FRAME]
            await self.source.capture_frame(rtc.AudioFrame(f.tobytes(), RATE, 1, FRAME))
            out.append((time.monotonic(), frame_db(f)))
        return out

    async def leave(self) -> None:
        for t in self.tasks:
            t.cancel()
        await self.room.disconnect()


def speech_bounds(
    series: list[tuple[float, float]], start: float, end: float, thr_db: float
) -> tuple[float | None, float | None, float]:
    loud = [t for t, db in series if start <= t <= end and db > thr_db]
    if not loud:
        return None, None, 0.0
    return loud[0], loud[-1], len(loud) / 100.0


async def wait_track(peer: Peer, name: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if name in peer.rx:
            return
        await asyncio.sleep(0.1)
    raise SystemExit(
        f"translated track {name} did not appear within {timeout}s (is the worker running and dispatched?)"
    )


async def run(args: argparse.Namespace) -> dict:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")
    url = args.url or os.environ.get("LIVEKIT_URL", "")
    key = os.environ.get("LIVEKIT_API_KEY", "")
    secret = os.environ.get("LIVEKIT_API_SECRET", "")
    if not (url and key and secret):
        raise SystemExit(
            "LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required"
        )

    clip = load_wav_48k_mono(Path(args.speaker_wav))
    gap = np.zeros(int(args.gap * RATE), np.int16)
    room = args.room or f"probe_{uuid.uuid4().hex[:10]}"
    speaker = Peer(
        "probe-speaker",
        args.speaker_lang,
        args.speaker_listen or args.speaker_lang,
        record=bool(args.record_dir),
    )
    listener = Peer(
        "probe-listener",
        args.listener_speak or args.listener_lang,
        args.listener_lang,
        record=bool(args.record_dir),
    )
    tx_main = f"tx:{speaker.identity}:{args.listener_lang}"
    tx_inter = f"tx:{listener.identity}:{speaker.listen}"

    await speaker.join(
        url,
        token(
            key,
            secret,
            room,
            speaker.identity,
            speaker.speak,
            speaker.listen,
            args.agent_name,
        ),
    )
    await listener.join(
        url,
        token(
            key,
            secret,
            room,
            listener.identity,
            listener.speak,
            listener.listen,
            args.agent_name,
        ),
    )
    await wait_track(listener, tx_main, args.dispatch_timeout)

    inter_clip = (
        load_wav_48k_mono(Path(args.interjection_wav))
        if args.interjection_wav
        else None
    )
    if inter_clip is not None:
        await wait_track(speaker, tx_inter, args.dispatch_timeout)
    await asyncio.sleep(1.0)

    thr = args.threshold_db
    reps = []
    for r in range(args.repeat):
        await listener.play(gap[: RATE // 2])  # keep listener mic alive (silence)
        play_main = speaker.play(np.concatenate([clip, gap]))
        if inter_clip is not None:
            offset = np.zeros(int(args.interjection_at * RATE), np.int16)
            play_inter = listener.play(np.concatenate([offset, inter_clip, gap]))
            src, inter_src = await asyncio.gather(play_main, play_inter)
        else:
            src, inter_src = await play_main, None
        await asyncio.sleep(args.tail)
        s_on, s_end, s_dur = speech_bounds(src, src[0][0], src[-1][0], thr)
        if s_on is None:
            raise SystemExit(
                "could not detect speech in the speaker clip; lower --threshold-db"
            )
        rx = listener.rx.get(tx_main, [])
        t_on, t_end, _ = speech_bounds(rx, s_on, s_end + args.tail + args.gap, thr)
        heard_before_end = speech_bounds(rx, s_on, s_end, thr)[2]
        rep = {
            "rep": r + 1,
            "source_speech_s": round(s_end - s_on, 2),
            "first_translated_audio_s": round(t_on - s_on, 3) if t_on else None,
            "began_before_source_end": bool(t_on and t_on < s_end),
            "translated_speech_heard_before_source_end_s": round(heard_before_end, 2),
            "source_speech_frames_s": round(s_dur, 2),
            "end_catch_up_s": round(t_end - s_end, 3) if t_end else None,
        }
        if inter_src is not None:
            i_on, _, _ = speech_bounds(
                inter_src, inter_src[0][0], inter_src[-1][0], thr
            )
            rxi = speaker.rx.get(tx_inter, [])
            ti_on, _, _ = (
                speech_bounds(rxi, i_on or 0, (i_on or 0) + 15, thr)
                if i_on
                else (None, None, 0)
            )
            rep["interjection_to_first_audio_s"] = (
                round(ti_on - i_on, 3) if ti_on and i_on else None
            )
            rep["interjection_heard_before_main_ended"] = bool(ti_on and ti_on < s_end)
        reps.append(rep)
        print(json.dumps(rep), flush=True)

    worker_first = [
        e["latencyMs"] for e in listener.events if e.get("t") == "first_audio"
    ]
    states = [e.get("state") for e in listener.events if e.get("t") == "session"]
    firsts = [
        r["first_translated_audio_s"]
        for r in reps
        if r["first_translated_audio_s"] is not None
    ]
    inters = [
        r.get("interjection_to_first_audio_s")
        for r in reps
        if r.get("interjection_to_first_audio_s") is not None
    ]
    summary = {
        "date_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "room": room,
        "livekit_url_host": url.split("//")[-1].split("/")[0],
        "agent_name": args.agent_name,
        "pair": f"{args.speaker_lang}->{args.listener_lang}",
        "clip": Path(args.speaker_wav).name,
        "repetitions": len(reps),
        "first_audio_p50_s": round(pct(firsts, 50), 3) if firsts else None,
        "first_audio_p95_s": round(pct(firsts, 95), 3) if firsts else None,
        "first_audio_mean_s": round(statistics.mean(firsts), 3) if firsts else None,
        "began_before_source_end_all": all(r["began_before_source_end"] for r in reps),
        "interjection_p50_s": round(pct(inters, 50), 3) if inters else None,
        "interjection_p95_s": round(pct(inters, 95), 3) if inters else None,
        "worker_first_audio_ms": worker_first,
        "worker_session_states": states,
        "host": platform.platform(),
        "reps": reps,
        "note": "Synthetic participants on this host; not a phone/Bluetooth measurement.",
    }

    if args.record_dir:
        out_dir = Path(args.record_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, chunks in {
            **listener.rx_audio,
            **{f"at-speaker-{k}": v for k, v in speaker.rx_audio.items()},
        }.items():
            if not chunks:
                continue
            path = out_dir / (name.replace(":", "_") + ".wav")
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(b"".join(chunks))

    await speaker.leave()
    await listener.leave()
    return summary


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--speaker-wav", required=True)
    p.add_argument("--speaker-lang", required=True, choices=["en", "pl", "es", "auto"])
    p.add_argument(
        "--speaker-listen",
        choices=["en", "pl", "es"],
        help="speaker's listening language (default = speak lang)",
    )
    p.add_argument("--listener-lang", required=True, choices=["en", "pl", "es"])
    p.add_argument("--listener-speak", choices=["en", "pl", "es", "auto"])
    p.add_argument(
        "--interjection-wav", help="clip spoken by the listener during the main clip"
    )
    p.add_argument("--interjection-at", type=float, default=8.0)
    p.add_argument("--repeat", type=int, default=3)
    p.add_argument(
        "--gap", type=float, default=6.0, help="silence between repetitions (s)"
    )
    p.add_argument(
        "--tail", type=float, default=4.0, help="wait after each repetition (s)"
    )
    p.add_argument("--threshold-db", type=float, default=-45.0)
    p.add_argument(
        "--agent-name",
        default=os.environ.get("TRANSLATOR_AGENT_NAME", "gemini-translator"),
    )
    p.add_argument("--url")
    p.add_argument("--room")
    p.add_argument("--dispatch-timeout", type=float, default=45.0)
    p.add_argument("--record-dir")
    p.add_argument("--out")
    args = p.parse_args()
    summary = asyncio.run(run(args))
    text = json.dumps(summary, indent=2)
    print(text)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())

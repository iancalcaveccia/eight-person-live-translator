"""End-to-end over real WebRTC: local livekit-server + the real worker process
(TRANSLATION_PROVIDER=mock) + two synthetic participants.

Run with:  LIVEKIT_INTEGRATION=1 uv run pytest tests/integration -s
Requires a livekit-server binary (LIVEKIT_SERVER_BIN, default
C:\\Users\\ianca\\tools\\livekit-server\\livekit-server.exe) or a server already
listening on 127.0.0.1:7880 in --dev mode (devkey/secret).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import pytest
from helpers import frames_of, silence, speech_like
from livekit import api, rtc

pytestmark = pytest.mark.skipif(
    os.environ.get("LIVEKIT_INTEGRATION") != "1",
    reason="set LIVEKIT_INTEGRATION=1 to run",
)

URL = os.environ.get("LIVEKIT_IT_URL", "ws://127.0.0.1:7880")
KEY = os.environ.get("LIVEKIT_IT_KEY", "devkey")
SECRET = os.environ.get("LIVEKIT_IT_SECRET", "secret")
SERVER_BIN = os.environ.get(
    "LIVEKIT_SERVER_BIN", r"C:\Users\ianca\tools\livekit-server\livekit-server.exe"
)
AGENT_NAME = "gemini-translator"
TRANSLATOR_DIR = Path(__file__).resolve().parents[2]
RATE = 48000


def _port_open(host: str, port: int) -> bool:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


@pytest.fixture(scope="module")
def livekit_server():
    proc = None
    if not _port_open("127.0.0.1", 7880):
        proc = subprocess.Popen(
            [SERVER_BIN, "--dev", "--bind", "127.0.0.1"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 15
        while time.time() < deadline and not _port_open("127.0.0.1", 7880):
            time.sleep(0.2)
        assert _port_open("127.0.0.1", 7880), "livekit-server did not start"
    yield URL
    if proc is not None:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=10)


@pytest.fixture(scope="module")
def worker(livekit_server, tmp_path_factory):
    log_path = tmp_path_factory.mktemp("worker") / "worker.log"
    env = {
        **os.environ,
        "LIVEKIT_URL": URL,
        "LIVEKIT_API_KEY": KEY,
        "LIVEKIT_API_SECRET": SECRET,
        "TRANSLATION_PROVIDER": "mock",
        "MOCK_DELAY_MS": os.environ.get("MOCK_DELAY_MS", "1200"),
        "CONTROL_PLANE_URL": "",
        "GEMINI_API_KEY": "",
        "OPENAI_API_KEY": "",
        "PYTHONUNBUFFERED": "1",
    }
    log = open(log_path, "w", encoding="utf-8")  # noqa: SIM115
    proc = subprocess.Popen(
        [sys.executable, "src/agent.py", "start"],
        cwd=TRANSLATOR_DIR,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 60
    registered = False
    while time.time() < deadline:
        time.sleep(0.5)
        text = log_path.read_text(encoding="utf-8", errors="replace")
        if "registered worker" in text.lower():
            registered = True
            break
        if proc.poll() is not None:
            break
    if not registered:
        proc.kill()
        pytest.fail(
            "worker did not register:\n"
            + log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        )
    yield log_path
    proc.terminate()
    with contextlib.suppress(Exception):
        proc.wait(timeout=15)
    log.close()


def _token(room: str, identity: str, speak: str, listen: str) -> str:
    dispatch = json.dumps(
        {"v": 1, "gatheringId": "g-it", "groupId": "grp-it", "room": room}
    )
    return (
        api.AccessToken(KEY, SECRET)
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
                agents=[
                    api.RoomAgentDispatch(agent_name=AGENT_NAME, metadata=dispatch)
                ],
                empty_timeout=60,
                departure_timeout=20,
                max_participants=10,
            )
        )
        .to_jwt()
    )


class Peer:
    def __init__(self, room_name: str, identity: str, speak: str, listen: str) -> None:
        self.room_name = room_name
        self.identity = identity
        self.speak_lang = speak
        self.listen_lang = listen
        self.room = rtc.Room()
        # Small queue: capture_frame() back-pressure paces publishing in real
        # time (more accurate than asyncio timers on Windows).
        self.source = rtc.AudioSource(RATE, 1, queue_size_ms=40)
        self.loud_frames: dict[
            str, list[float]
        ] = {}  # track name -> arrival times of loud frames
        self.events: list[dict] = []
        self._tasks: list[asyncio.Task] = []

    async def connect(self) -> None:
        @self.room.on("track_subscribed")
        def _on_track(track, pub, participant):
            if track.kind == rtc.TrackKind.KIND_AUDIO and pub.name.startswith("tx:"):
                self._tasks.append(asyncio.create_task(self._listen(track, pub.name)))

        @self.room.on("data_received")
        def _on_data(packet):
            if packet.topic == "interp.events":
                with contextlib.suppress(Exception):
                    self.events.append(
                        {"rx": time.monotonic(), **json.loads(packet.data)}
                    )

        await self.room.connect(
            URL,
            _token(self.room_name, self.identity, self.speak_lang, self.listen_lang),
        )
        track = rtc.LocalAudioTrack.create_audio_track("microphone", self.source)
        await self.room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )

    async def _listen(self, track, name: str) -> None:
        stream = rtc.AudioStream.from_track(
            track=track, sample_rate=RATE, num_channels=1, frame_size_ms=10
        )
        times = self.loud_frames.setdefault(name, [])
        async for ev in stream:
            x = np.frombuffer(bytes(ev.frame.data.cast("b")), dtype=np.int16).astype(
                np.float32
            )
            if x.size and float(np.sqrt(np.mean(x * x))) > 300:
                times.append(time.monotonic())

    async def speak(self, audio: np.ndarray) -> tuple[float, float]:
        """Publish audio in real time; return (first speech frame time, end time).
        Loud source frame times are kept in `self.sent_loud`."""
        frames = frames_of(audio)
        t0 = time.monotonic()
        self.sent_loud: list[float] = []
        for f in frames:
            await self.source.capture_frame(rtc.AudioFrame(f, RATE, 1, len(f) // 2))
            x = np.frombuffer(f, dtype=np.int16).astype(np.float32)
            if float(np.sqrt(np.mean(x * x))) > 300:
                self.sent_loud.append(time.monotonic())
        first_loud = self.sent_loud[0] if self.sent_loud else t0
        last_loud = self.sent_loud[-1] if self.sent_loud else time.monotonic()
        return first_loud, last_loud

    async def close(self) -> None:
        for t in self._tasks:
            t.cancel()
        await self.room.disconnect()


async def _wait_agent(peer: Peer, track_name: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for p in peer.room.remote_participants.values():
            for pub in p.track_publications.values():
                if pub.name == track_name and pub.subscribed:
                    return
        await asyncio.sleep(0.1)
    raise AssertionError(f"{track_name} never appeared")


def _first_after(times: list[float], t: float) -> float | None:
    return next((x for x in times if x >= t), None)


async def test_translation_streams_before_monologue_ends(worker):
    room = f"grp_it_{uuid.uuid4().hex[:8]}"
    a = Peer(room, "spk-a", "es", "es")
    b = Peer(room, "lst-b", "pl", "pl")
    await a.connect()
    await b.connect()
    try:
        await _wait_agent(b, "tx:spk-a:pl")
        await asyncio.sleep(1.0)
        audio = np.concatenate([silence(0.5), speech_like(22.0, seed=21), silence(0.5)])
        start, end = await a.speak(audio)
        await asyncio.sleep(3.0)
        rx = b.loud_frames.get("tx:spk-a:pl", [])
        first = _first_after(rx, start)
        assert first is not None, "listener never received translated audio"
        latency = first - start
        received_before_end = [x for x in rx if start <= x <= end]
        # Source speech that could already have been translated by `end`.
        translatable = [x for x in a.sent_loud if x <= end - latency]
        coverage = len(received_before_end) / max(1, len(translatable))
        catch_up = (rx[-1] - end) if rx else None
        report = {
            "test": "monologue_22s_es_to_pl_mock",
            "first_translated_audio_s": round(latency, 3),
            "source_speech_s": round(end - start, 2),
            "translated_speech_heard_before_source_end_s": round(
                len(received_before_end) / 100.0, 2
            ),
            "coverage_vs_translatable_source": round(coverage, 3),
            "end_catch_up_s": round(catch_up, 3) if catch_up is not None else None,
            "worker_first_audio_events_ms": [
                e["latencyMs"] for e in b.events if e.get("t") == "first_audio"
            ],
        }
        print("\nINTEGRATION", json.dumps(report))
        assert first < end - 15.0, (
            "translation must start long before the speaker stops"
        )
        assert coverage > 0.85, (
            "translated audio must flow continuously during the monologue"
        )
        assert catch_up is not None and catch_up < 3.0, (
            "no accumulating backlog at the end"
        )
    finally:
        await a.close()
        await b.close()


async def test_interjection_is_heard_while_main_speaker_continues(worker):
    room = f"grp_it_{uuid.uuid4().hex[:8]}"
    a = Peer(room, "spk-a", "es", "es")
    b = Peer(room, "spk-b", "pl", "pl")
    await a.connect()
    await b.connect()
    try:
        await _wait_agent(b, "tx:spk-a:pl")
        await _wait_agent(a, "tx:spk-b:es")
        await asyncio.sleep(1.0)
        main = np.concatenate([silence(0.3), speech_like(20.0, seed=31)])
        inter = np.concatenate([silence(8.3), speech_like(1.5, seed=32), silence(11.0)])
        (a_start, a_end), (b_start_wall, _) = await asyncio.gather(
            a.speak(main), b.speak(inter)
        )
        await asyncio.sleep(3.0)
        inter_start = b_start_wall  # first loud frame of B's interjection
        rx_at_a = a.loud_frames.get("tx:spk-b:es", [])
        first_inter = _first_after(rx_at_a, inter_start)
        assert first_inter is not None, (
            "interjection translation never reached the main speaker"
        )
        rx_at_b = b.loud_frames.get("tx:spk-a:pl", [])
        main_during = [x for x in rx_at_b if inter_start <= x <= inter_start + 3.0]
        report = {
            "test": "interjection_at_8s_pl_to_es_mock",
            "interjection_to_first_audio_s": round(first_inter - inter_start, 3),
            "heard_before_main_speaker_finished": first_inter < a_end,
            "main_translation_frames_during_interjection": len(main_during),
            "main_first_audio_s": round(
                (_first_after(rx_at_b, a_start) or 0) - a_start, 3
            ),
        }
        print("\nINTEGRATION", json.dumps(report))
        assert first_inter < a_end - 5.0
        assert len(main_during) > 100, (
            "main speaker's translation must keep flowing (>1 s of audio)"
        )
    finally:
        await a.close()
        await b.close()

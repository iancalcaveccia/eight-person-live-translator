"""Room I/O: publishing tracks, captions, worker events and status attributes.

`RoomIO` is a small protocol so sessions and the router can be unit-tested
with `FakeRoomIO` instead of a live LiveKit room.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any, Protocol

from audio import AudioSink, FakeAudioSink, LiveKitAudioSink
from config import CAPTIONS_TOPIC, EVENTS_TOPIC

logger = logging.getLogger("translator.events")


class RoomIO(Protocol):
    def make_sink(self, sample_rate: int) -> AudioSink: ...

    async def publish_audio(self, name: str, sink: AudioSink) -> str: ...

    async def unpublish(self, sid: str) -> None: ...

    async def publish_event(self, payload: dict[str, Any]) -> None: ...

    async def publish_caption(
        self, *, text: str, sender_identity: str, attributes: dict[str, str]
    ) -> None: ...

    async def set_attributes(self, attributes: dict[str, str]) -> None: ...


def encode_event(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class LiveKitRoomIO:
    def __init__(self, room: Any, *, output_queue_ms: int) -> None:
        self._room = room
        self._queue_ms = output_queue_ms

    def make_sink(self, sample_rate: int) -> AudioSink:
        return LiveKitAudioSink(sample_rate, self._queue_ms)

    async def publish_audio(self, name: str, sink: AudioSink) -> str:
        from livekit import rtc

        assert isinstance(sink, LiveKitAudioSink)
        track = rtc.LocalAudioTrack.create_audio_track(name, sink.source)
        opts = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        pub = await self._room.local_participant.publish_track(track, opts)
        return pub.sid

    async def unpublish(self, sid: str) -> None:
        try:
            await self._room.local_participant.unpublish_track(sid)
        except Exception as exc:
            logger.debug("unpublish %s failed: %s", sid, exc)

    async def publish_event(self, payload: dict[str, Any]) -> None:
        try:
            await self._room.local_participant.publish_data(
                encode_event(payload), reliable=True, topic=EVENTS_TOPIC
            )
        except Exception as exc:
            logger.debug("event publish failed: %s", exc)

    async def publish_caption(
        self, *, text: str, sender_identity: str, attributes: dict[str, str]
    ) -> None:
        try:
            writer = await self._room.local_participant.stream_text(
                topic=CAPTIONS_TOPIC,
                sender_identity=sender_identity,
                attributes=attributes,
            )
            if text:
                await writer.write(text)
            await writer.aclose()
        except Exception as exc:
            logger.debug("caption publish failed: %s", exc)

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        with contextlib.suppress(Exception):
            await self._room.local_participant.set_attributes(attributes)


class FakeRoomIO:
    """Records everything for assertions in tests."""

    def __init__(self) -> None:
        self.tracks: dict[str, tuple[str, FakeAudioSink]] = {}
        self.unpublished: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.captions: list[dict[str, Any]] = []
        self.attributes: dict[str, str] = {}
        self._n = 0

    def make_sink(self, sample_rate: int) -> AudioSink:
        return FakeAudioSink(sample_rate)

    async def publish_audio(self, name: str, sink: AudioSink) -> str:
        self._n += 1
        sid = f"TR_{self._n}"
        assert isinstance(sink, FakeAudioSink)
        self.tracks[sid] = (name, sink)
        return sid

    async def unpublish(self, sid: str) -> None:
        self.unpublished.append(sid)
        self.tracks.pop(sid, None)

    async def publish_event(self, payload: dict[str, Any]) -> None:
        self.events.append(payload)

    async def publish_caption(
        self, *, text: str, sender_identity: str, attributes: dict[str, str]
    ) -> None:
        self.captions.append({"text": text, "sender": sender_identity, **attributes})

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        self.attributes.update(attributes)

    def track_names(self) -> list[str]:
        return sorted(name for name, _ in self.tracks.values())

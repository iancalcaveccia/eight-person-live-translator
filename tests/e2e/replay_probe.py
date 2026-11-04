"""Attack probe: join a LiveKit room with a previously issued token.

Usage: python replay_probe.py <ws_url> <token> <wait_seconds>

Prints one JSON line: {"connected": bool, "evicted": bool, "evictedAfterMs": int|null,
"reason": str|null}. Used by the E2E suite to prove that a participant who
moved to another group cannot re-enter the old room with an old token: the
translator worker asks the control plane and removes them.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

from livekit import rtc


async def main(url: str, token: str, wait_s: float) -> None:
    room = rtc.Room()
    disconnected = asyncio.Event()
    reason: dict[str, str | None] = {"value": None}

    @room.on("disconnected")
    def _on_disc(r) -> None:
        reason["value"] = str(r)
        disconnected.set()

    t0 = time.monotonic()
    try:
        await room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
    except Exception as exc:  # rejected at join time is also a pass for the caller
        print(json.dumps({"connected": False, "evicted": True, "evictedAfterMs": 0, "reason": f"join_failed: {exc}"}))
        return
    try:
        await asyncio.wait_for(disconnected.wait(), timeout=wait_s)
        evicted = True
    except asyncio.TimeoutError:
        evicted = False
    elapsed = int((time.monotonic() - t0) * 1000)
    print(
        json.dumps(
            {
                "connected": True,
                "evicted": evicted,
                "evictedAfterMs": elapsed if evicted else None,
                "reason": reason["value"],
            }
        )
    )
    await room.disconnect()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], float(sys.argv[3])))

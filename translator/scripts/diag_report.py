"""Read back the interpreter's content-free diagnostics (kept 30 days).

    uv run python scripts/diag_report.py --hours 6             # every room
    uv run python scripts/diag_report.py --room grp_...        # one room
    uv run python scripts/diag_report.py --hours 24 --json out.json

Signed with INTERNAL_API_SECRET against CONTROL_PLANE_URL (both read from
translator/.env.local, never printed). The data holds no names, no words and
no audio: stream open/close, per-minute delay and language-label counts,
drops, reconnections, overheard-mic holds.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from control_plane import ControlPlaneClient

DEFAULT_APP_URL = "https://eight-person-live-translator.vercel.app"


def _hhmm(ts: str) -> str:
    return ts[11:19] if len(ts) >= 19 else ts


def _short(v: str | None) -> str:
    return (v or "-")[:8]


def _as_dict(v: object) -> dict:
    """Events stored before the web fix of 2026-11-18 carry their data as a
    JSON string; newer ones as an object."""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def render(data: dict) -> str:
    rooms: dict[str, list[dict]] = defaultdict(list)
    for e in data["events"]:
        e["data"] = _as_dict(e.get("data"))
        rooms[e.get("room") or "?"].append(e)
    out = [
        f"diagnostics {data['since']} .. {data['until']}  ({len(data['events'])} events)"
    ]
    for room, evs in rooms.items():
        out.append("")
        out.append(
            f"== room {room}  {_hhmm(evs[0]['created_at'])}-{_hhmm(evs[-1]['created_at'])} UTC"
        )
        declared = {
            e["speaker_id"]: e["data"].get("speak_lang", "?")
            for e in evs
            if e["kind"] == "session_started" and e.get("speaker_id")
        }
        if declared:
            out.append(
                "   speakers: "
                + ", ".join(f"{_short(k)}={v}" for k, v in declared.items())
            )
        for e in evs:
            d = e["data"]
            who = f"{_short(e.get('speaker_id'))}->{e.get('target_lang') or '-'}"
            t = _hhmm(e["created_at"])
            if e["kind"] == "minute":
                heard = d.get("heard") or {}
                own = declared.get(e.get("speaker_id"), "")
                total = sum(heard.values()) or 0
                other = sum(n for lang, n in heard.items() if lang != own) if own else 0
                out.append(
                    f"   {t} {who:<12} min {d.get('age_min', '?'):>5}  out {d.get('output_s', 0):>5}s"
                    f"  p50 {d.get('first_audio_p50_ms', -1):>5}ms  heard {heard}"
                    f"{f' ({other}/{total} not {own})' if own and total else ''}"
                    f"  same-drop {d.get('same_language_dropped_s', 0)}s  xt-drop {d.get('crosstalk_dropped_s', 0)}s"
                    f"  withheld {d.get('withheld_s', 0)}s  backlog max {d.get('backlog_max_ms', 0)}ms"
                    f" drop {d.get('backlog_dropped_ms', 0)}ms  rot {d.get('rotations', 0)}"
                    f" (stuck {d.get('stall_rotations', 0)})"
                    f"  reconn {d.get('reconnects', 0)}  {d.get('state', '')}"
                )
            else:
                body = " ".join(f"{k}={v}" for k, v in d.items())
                out.append(f"   {t} {who:<12} {e['kind']:<17} {body}")
    usage = data.get("usage") or []
    if usage:
        cost = sum(float(u.get("cost_usd") or 0) for u in usage)
        out.append("")
        out.append(f"usage rows: {len(usage)}, estimated cost ${cost:.2f}")
    return "\n".join(out)


async def fetch(hours: float, room: str | None) -> dict:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")
    # Production secrets written by scripts/configure-cloud.ps1 (gitignored).
    generated = dotenv_values(
        Path(__file__).resolve().parents[2] / ".secrets" / "generated.env"
    )
    base = (
        os.environ.get("CONTROL_PLANE_URL")
        or os.environ.get("MESA_APP_URL")
        or DEFAULT_APP_URL
    ).rstrip("/")
    secret = (
        os.environ.get("INTERNAL_API_SECRET")
        or generated.get("INTERNAL_API_SECRET")
        or ""
    )
    if not secret:
        raise SystemExit(
            "INTERNAL_API_SECRET is needed (translator/.env.local or .secrets/generated.env)"
        )
    client = ControlPlaneClient(base_url=base, secret=secret)
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours * 3600))
    body: dict = {"since": since}
    if room:
        body["room"] = room
    try:
        return await client._post("/api/internal/diagnostics", body)
    finally:
        await client.aclose()


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--hours", type=float, default=6.0)
    p.add_argument("--room")
    p.add_argument("--json", help="also write the raw data to this file")
    args = p.parse_args()
    data = asyncio.run(fetch(args.hours, args.room))
    if args.json:
        Path(args.json).write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(render(data))


if __name__ == "__main__":
    main()

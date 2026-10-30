"""LiveKit Agents entrypoint: one translation router per GROUP media room.

The control plane embeds a RoomAgentDispatch (agent name below) in every media
token's RoomConfiguration, so LiveKit Cloud starts exactly one job per group
room. Dispatch metadata carries {gatheringId, groupId} (CONTRACT.md §1).
"""

from __future__ import annotations

import json
import logging
import os

from dotenv import load_dotenv
from livekit import api
from livekit.agents import AgentServer, AutoSubscribe, JobContext, cli

from config import ATTR_AGENT_STATUS, load_settings
from control_plane import ControlPlaneClient
from events import LiveKitRoomIO
from providers import build_providers
from router import TranslationRouter

logger = logging.getLogger("translator.agent")

load_dotenv(".env.local")

SETTINGS = load_settings()

server = AgentServer()


def parse_dispatch_metadata(raw: str | None, room_name: str) -> tuple[str, str]:
    """Return (gatheringId, groupId); falls back to the room name in dev."""
    if raw:
        try:
            data = json.loads(raw)
            gathering = str(data.get("gatheringId") or "")
            group = str(data.get("groupId") or "")
            if gathering and group:
                return gathering, group
        except (json.JSONDecodeError, AttributeError):
            pass
    return room_name, room_name


# Dispatch name must match the control plane (CONTRACT.md §1). Overridable
# only so a latency-probe worker can run beside production without collisions.
@server.rtc_session(agent_name=SETTINGS.agent_name)
async def translator_entrypoint(ctx: JobContext) -> None:
    settings = load_settings()
    ctx.log_context_fields = {"room": ctx.room.name}

    providers = build_providers(settings)
    if not providers:
        logger.error(
            "no translation provider configured (set GEMINI_API_KEY, OPENAI_API_KEY or "
            "TRANSLATION_PROVIDER=mock); refusing to start"
        )
        return
    if settings.translation_provider not in providers:
        logger.warning(
            "TRANSLATION_PROVIDER=%s has no credentials; available: %s",
            settings.translation_provider,
            ",".join(sorted(providers)),
        )

    gathering_id, group_id = parse_dispatch_metadata(ctx.job.metadata, ctx.room.name)
    control_plane = ControlPlaneClient(
        base_url=settings.control_plane_url,
        secret=settings.internal_api_secret,
        timeout_sec=settings.http_timeout_sec,
    )

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    room_io = LiveKitRoomIO(ctx.room, output_queue_ms=settings.output_queue_ms)
    await room_io.set_attributes(
        {
            "lk.agent.state": "listening",
            ATTR_AGENT_STATUS: json.dumps(
                {
                    "budget": "ok",
                    "sessions": 0,
                    "provider": settings.translation_provider,
                },
                separators=(",", ":"),
            ),
        }
    )

    async def evict(identity: str, reason: str) -> None:
        logger.warning("removing participant %s (%s)", identity, reason)
        await ctx.api.room.remove_participant(
            api.RoomParticipantIdentity(room=ctx.room.name, identity=identity)
        )

    router = TranslationRouter(
        room=ctx.room,
        room_io=room_io,
        providers=providers,
        settings=settings,
        control_plane=control_plane,
        gathering_id=gathering_id,
        group_id=group_id,
        evict=evict,
        shutdown=lambda reason: ctx.shutdown(reason=reason),
    )
    router.start()

    async def _shutdown() -> None:
        await router.aclose()

    ctx.add_shutdown_callback(_shutdown)
    logger.info(
        "translation router ready room=%s gathering=%s group=%s providers=%s standalone=%s",
        ctx.room.name,
        gathering_id,
        group_id,
        ",".join(sorted(providers)),
        control_plane.standalone,
    )


if __name__ == "__main__":
    if os.environ.get("TRANSLATOR_LOG_LEVEL"):
        logging.basicConfig(level=os.environ["TRANSLATOR_LOG_LEVEL"].upper())
    cli.run_app(server)

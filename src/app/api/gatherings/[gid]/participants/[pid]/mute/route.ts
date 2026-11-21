import { muteParticipant } from "@/server/gatherings";
import { json, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Host mutes someone's microphone (only within the host's current conversation). */
export const POST = participantRoute<{ gid: string; pid: string }>(
  async (_req, ctx, params) => json({ ok: await muteParticipant(ctx, requireUuid(params.pid, "participant id")) }),
  { mutating: true },
);

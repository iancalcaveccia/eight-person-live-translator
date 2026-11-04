import { kickParticipant } from "@/server/gatherings";
import { json, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Host removes someone from the gathering; their session and media access end. */
export const POST = participantRoute<{ gid: string; pid: string }>(
  async (_req, ctx, params) => {
    await kickParticipant(ctx, requireUuid(params.pid, "participant id"));
    return json({ ok: true });
  },
  { mutating: true },
);

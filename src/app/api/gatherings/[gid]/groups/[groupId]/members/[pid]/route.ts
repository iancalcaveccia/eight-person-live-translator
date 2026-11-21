import { removeFromGroup } from "@/server/gatherings";
import { json, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Conversation owner removes someone; they are moved back to Main server-side. */
export const DELETE = participantRoute<{ gid: string; groupId: string; pid: string }>(
  async (_req, ctx, params) => {
    await removeFromGroup(ctx, requireUuid(params.groupId, "group id"), requireUuid(params.pid, "participant id"));
    return json({ ok: true });
  },
  { mutating: true },
);

import { enterGroup } from "@/server/gatherings";
import { json, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Switch your audio to another conversation you are authorized for. */
export const POST = participantRoute<{ gid: string; groupId: string }>(
  async (_req, ctx, params) => json(await enterGroup(ctx, requireUuid(params.groupId, "group id"))),
  { mutating: true },
);

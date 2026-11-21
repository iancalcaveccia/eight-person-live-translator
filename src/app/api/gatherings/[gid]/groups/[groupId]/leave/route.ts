import { leaveGroup } from "@/server/gatherings";
import { json, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Leave a private conversation (returns you to Main if you were in it). */
export const POST = participantRoute<{ gid: string; groupId: string }>(
  async (_req, ctx, params) => json(await leaveGroup(ctx, requireUuid(params.groupId, "group id"))),
  { mutating: true },
);

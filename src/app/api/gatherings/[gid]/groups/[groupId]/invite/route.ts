import { inviteToGroup } from "@/server/gatherings";
import { ApiError, json, readJson, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

export const POST = participantRoute<{ gid: string; groupId: string }>(
  async (req, ctx, params) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.participantIds) ? body.participantIds : [];
    if (ids.length === 0 || !ids.every((x) => typeof x === "string")) {
      throw new ApiError(400, "invalid_input", "participantIds is required");
    }
    const sent = await inviteToGroup(ctx, requireUuid(params.groupId, "group id"), ids as string[]);
    return json({ ok: true, sent });
  },
  { mutating: true },
);

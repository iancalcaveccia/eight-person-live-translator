import { respondToInvitation } from "@/server/gatherings";
import { ApiError, json, readJson, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

export const POST = participantRoute<{ gid: string; invId: string }>(
  async (req, ctx, params) => {
    const body = await readJson(req);
    if (body.action !== "accept" && body.action !== "decline") {
      throw new ApiError(400, "invalid_input", "action must be accept or decline");
    }
    const media = await respondToInvitation(ctx, requireUuid(params.invId, "invitation id"), body.action);
    return json({ ok: true, media });
  },
  { mutating: true },
);

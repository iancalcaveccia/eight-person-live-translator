import { renameGroup } from "@/server/gatherings";
import { json, readJson, requireUuid } from "@/server/http";
import { participantRoute } from "@/server/routes";
import { cleanText } from "@/server/validation";

export const runtime = "nodejs";

export const PATCH = participantRoute<{ gid: string; groupId: string }>(
  async (req, ctx, params) => {
    const body = await readJson(req);
    await renameGroup(ctx, requireUuid(params.groupId, "group id"), cleanText(body.name, "Conversation name", 40));
    return json({ ok: true });
  },
  { mutating: true },
);

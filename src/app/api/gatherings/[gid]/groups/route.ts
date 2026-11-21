import { createPrivateGroup } from "@/server/gatherings";
import { ApiError, json, readJson } from "@/server/http";
import { participantRoute } from "@/server/routes";
import { cleanText } from "@/server/validation";

export const runtime = "nodejs";

/** Start a private conversation, invite people, and move the creator into it. */
export const POST = participantRoute(
  async (req, ctx) => {
    const body = await readJson(req);
    const name = cleanText(body.name, "Conversation name", 40);
    const invitees = Array.isArray(body.inviteeIds) ? body.inviteeIds : [];
    if (!invitees.every((x) => typeof x === "string")) throw new ApiError(400, "invalid_input");
    const result = await createPrivateGroup(ctx, name, invitees as string[]);
    return json(result, { status: 201 });
  },
  { mutating: true },
);

import { joinGathering } from "@/server/gatherings";
import {
  ApiError,
  assertSameOrigin,
  clientIp,
  handle,
  json,
  readJson,
  requireUuid,
  serializeSessionCookie,
} from "@/server/http";
import { cleanText, parseLanguagePrefs, requireConsent } from "@/server/validation";

export const runtime = "nodejs";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ gid: string }> }) => {
  assertSameOrigin(req);
  const gid = requireUuid((await ctx.params).gid, "gathering id");
  const body = await readJson(req);
  requireConsent(body);
  if (typeof body.inviteToken !== "string" || body.inviteToken.length < 16 || body.inviteToken.length > 64) {
    throw new ApiError(403, "invalid_invite", "This invite link is not valid. Ask the host for a new one.");
  }
  const result = await joinGathering(
    gid,
    {
      ...parseLanguagePrefs(body),
      inviteToken: body.inviteToken,
      displayName: cleanText(body.displayName, "Your name", 40),
    },
    clientIp(req),
  );
  return json(
    { gatheringId: result.gatheringId, participantId: result.participantId },
    {
      status: 201,
      headers: {
        "set-cookie": serializeSessionCookie(result.gatheringId, result.sessionSecret, result.cookieMaxAgeSeconds),
      },
    },
  );
});

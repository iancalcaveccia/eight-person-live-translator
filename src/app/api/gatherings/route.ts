import { createGathering } from "@/server/gatherings";
import { assertSameOrigin, clientIp, handle, json, readJson, serializeSessionCookie } from "@/server/http";
import { cleanText, parseLanguagePrefs, requireConsent } from "@/server/validation";

export const runtime = "nodejs";

/** Create a gathering. Requires HOST_ACCESS_CODE on hosted deployments. */
export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  requireConsent(body);
  const prefs = parseLanguagePrefs(body);
  const result = await createGathering(
    {
      ...prefs,
      hostCode: typeof body.hostCode === "string" ? body.hostCode : undefined,
      title: cleanText(body.title ?? "Our gathering", "Gathering name", 60),
      displayName: cleanText(body.displayName, "Your name", 40),
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : undefined,
    },
    clientIp(req),
  );
  return json(
    { gatheringId: result.gatheringId, participantId: result.participantId, inviteUrlPath: result.inviteUrlPath },
    {
      status: 201,
      headers: {
        "set-cookie": serializeSessionCookie(result.gatheringId, result.sessionSecret, result.cookieMaxAgeSeconds),
      },
    },
  );
});

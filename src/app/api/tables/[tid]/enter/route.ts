import { enterTableGathering } from "@/server/gatherings";
import { assertSameOrigin, clientIp, handle, json, requireUuid, serializeSessionCookie } from "@/server/http";
import { requireCurrentConsent, requireMembership, requirePerson } from "@/server/people";

export const runtime = "nodejs";

/** One tap from the home screen: sit down at a saved table (joins the live gathering or starts one). */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ tid: string }> }) => {
  assertSameOrigin(req);
  const tid = requireUuid((await ctx.params).tid, "table id");
  const person = await requirePerson(req);
  await requireMembership(person, tid);
  requireCurrentConsent(person);
  const seat = await enterTableGathering(
    tid,
    {
      personId: person.id,
      displayName: person.display_name,
      prefs: { speakLang: person.speak_lang, listenLang: person.listen_lang, esRegion: person.es_region },
    },
    clientIp(req),
  );
  return json(
    { gatheringId: seat.gatheringId },
    { headers: { "set-cookie": serializeSessionCookie(seat.gatheringId, seat.sessionSecret, seat.cookieMaxAgeSeconds) } },
  );
});

import { enterTableGathering } from "@/server/gatherings";
import {
  assertSameOrigin,
  clientIp,
  cookieHeaders,
  handle,
  json,
  readJson,
  requireUuid,
  serializePersonCookie,
  serializeSessionCookie,
} from "@/server/http";
import { addTableMember, createPerson, currentPerson, updatePerson, verifyTableInvite } from "@/server/people";
import { CONSENT_VERSION } from "@/server/env";
import { cleanText, parseLanguagePrefs, requireConsent } from "@/server/validation";

export const runtime = "nodejs";

/**
 * Open a table link. Remembered people (existing, or `remember: true` with a
 * name and languages) are added to the table and seated; `remember: false`
 * seats a one-time guest who is not saved anywhere.
 */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ tid: string }> }) => {
  assertSameOrigin(req);
  const tid = requireUuid((await ctx.params).tid, "table id");
  const body = await readJson(req);
  const ip = clientIp(req);
  await verifyTableInvite(tid, body.inviteToken, ip);

  const cookies: string[] = [];
  let person = await currentPerson(req);
  if (!person) {
    requireConsent(body);
    const prefs = parseLanguagePrefs(body);
    const displayName = cleanText(body.displayName, "Your name", 40);
    if (body.remember === false) {
      const seat = await enterTableGathering(tid, { personId: null, displayName, prefs }, ip);
      return json(
        { gatheringId: seat.gatheringId, remembered: false },
        { status: 201, headers: { "set-cookie": serializeSessionCookie(seat.gatheringId, seat.sessionSecret, seat.cookieMaxAgeSeconds) } },
      );
    }
    const created = await createPerson({ ...prefs, displayName }, ip);
    person = created.person;
    cookies.push(serializePersonCookie(created.secret));
  } else if (person.consent_version !== CONSENT_VERSION) {
    requireConsent(body);
    person = await updatePerson(person, { consent: true });
  }

  await addTableMember(tid, person);
  const seat = await enterTableGathering(
    tid,
    {
      personId: person.id,
      displayName: person.display_name,
      prefs: { speakLang: person.speak_lang, listenLang: person.listen_lang, esRegion: person.es_region },
    },
    ip,
  );
  cookies.push(serializeSessionCookie(seat.gatheringId, seat.sessionSecret, seat.cookieMaxAgeSeconds));
  return json({ gatheringId: seat.gatheringId, remembered: true }, { status: 201, headers: cookieHeaders(...cookies) });
});

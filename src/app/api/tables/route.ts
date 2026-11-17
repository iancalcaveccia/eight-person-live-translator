import { enterTableGathering } from "@/server/gatherings";
import { assertSameOrigin, clientIp, handle, isUuid, json, readJson, serializeSessionCookie } from "@/server/http";
import { createTable, requirePerson } from "@/server/people";
import { cleanText } from "@/server/validation";

export const runtime = "nodejs";

/** Save a new table (optionally with people you already share a table with) and sit down at it. */
export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  const person = await requirePerson(req);
  const body = await readJson(req);
  const name = cleanText(body.name ?? "Our table", "Table name", 60);
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds.filter(isUuid).map((s) => s.toLowerCase()) : [];
  const ip = clientIp(req);
  const table = await createTable(
    person,
    { name, memberIds, hostCode: typeof body.hostCode === "string" ? body.hostCode : undefined },
    ip,
  );
  const seat = await enterTableGathering(
    table.id,
    {
      personId: person.id,
      displayName: person.display_name,
      prefs: { speakLang: person.speak_lang, listenLang: person.listen_lang, esRegion: person.es_region },
    },
    ip,
  );
  return json(
    { tableId: table.id, gatheringId: seat.gatheringId },
    { status: 201, headers: { "set-cookie": serializeSessionCookie(seat.gatheringId, seat.sessionSecret, seat.cookieMaxAgeSeconds) } },
  );
});

import {
  assertSameOrigin,
  clearPersonCookie,
  clientIp,
  handle,
  json,
  parseCookies,
  PERSON_COOKIE,
  readJson,
  serializePersonCookie,
} from "@/server/http";
import {
  createPerson,
  currentPerson,
  deletePerson,
  forgetDevice,
  homeView,
  personView,
  requirePerson,
  updatePerson,
} from "@/server/people";
import { cleanText, parseLanguagePrefs, parsePartialPrefs, requireConsent } from "@/server/validation";

export const runtime = "nodejs";

/** Who is remembered on this phone, their saved tables and their people. */
export const GET = handle(async (req: Request) => {
  const person = await currentPerson(req);
  if (!person) return json({ person: null, tables: [], people: [] });
  // Sliding expiry: every visit renews the same device cookie.
  const secret = parseCookies(req).get(PERSON_COOKIE)!;
  return json(await homeView(person), { headers: { "set-cookie": serializePersonCookie(secret) } });
});

/** Remember me on this phone (or update the profile already remembered here). */
export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  requireConsent(body);
  const prefs = parseLanguagePrefs(body);
  const displayName = cleanText(body.displayName, "Your name", 40);
  const existing = await currentPerson(req);
  if (existing) {
    const updated = await updatePerson(existing, { ...prefs, displayName, consent: true });
    return json({ person: personView(updated) });
  }
  const { person, secret } = await createPerson({ ...prefs, displayName }, clientIp(req));
  return json({ person: personView(person) }, { status: 201, headers: { "set-cookie": serializePersonCookie(secret) } });
});

export const PATCH = handle(async (req: Request) => {
  assertSameOrigin(req);
  const person = await requirePerson(req);
  const body = await readJson(req);
  const patch = {
    ...parsePartialPrefs(body),
    ...(body.displayName !== undefined ? { displayName: cleanText(body.displayName, "Your name", 40) } : {}),
    ...(body.consent === true ? { consent: true } : {}),
  };
  return json({ person: personView(await updatePerson(person, patch)) });
});

/** `{ everything: true }` deletes the person everywhere; otherwise only this phone forgets them. */
export const DELETE = handle(async (req: Request) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  if (body.everything === true) {
    await deletePerson(await requirePerson(req));
  } else {
    await forgetDevice(req);
  }
  return json({ ok: true }, { headers: { "set-cookie": clearPersonCookie() } });
});

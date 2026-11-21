/**
 * Remembered people ("keep me signed in on this phone") and their saved
 * tables. This module is a privacy boundary like gatherings.ts:
 *
 *  - A person is a name + languages + AI-consent version. No email, password
 *    or phone number. A device holds a 256-bit random secret in an httpOnly
 *    cookie; only its SHA-256 is stored, so a database leak cannot sign anyone in.
 *  - A table (DB: `circles`) is the set of people who talk together. Only its
 *    members see it, its members, who is at it right now, and its link.
 *  - Joining a table needs its link (HMAC of the table id + version). Members
 *    then re-enter with one tap; removing someone also replaces the link.
 *  - Contacts are only ever people you share a table with.
 */
import "server-only";
import type { ContactView, HomeView, PersonView, TablePreview, TableView } from "@/lib/api-types";
import type { EsRegion, ListenLang, SpeakLang } from "@/lib/languages";
import { getDb, type Queryable } from "./db";
import { CONSENT_VERSION, config } from "./env";
import { newId, newSessionSecret, safeEqual, sha256Hex } from "./crypto";
import { ApiError, parseCookies, PERSON_COOKIE } from "./http";
import { rateLimit } from "./ratelimit";
import { assertMayCreate, evictPersonFromTableGathering, tableInviteTokenFor, tableInviteUrlPath } from "./gatherings";
import type { LanguagePrefs } from "./validation";

export interface PersonRow {
  id: string;
  display_name: string;
  speak_lang: SpeakLang;
  listen_lang: ListenLang;
  es_region: EsRegion;
  consent_version: string;
  consent_at: Date;
  created_at: Date;
  last_seen_at: Date;
}

interface TableRow {
  id: string;
  name: string;
  invite_version: number;
  created_by: string | null;
  created_at: Date;
  last_used_at: Date;
}

export const MAX_TABLE_MEMBERS = 30;
export const MAX_TABLES_PER_PERSON = 20;
const SEEN_WRITE_INTERVAL_MS = 60_000;
const ONLINE_WINDOW_SECONDS = 25;

export function personView(p: PersonRow): PersonView {
  return {
    id: p.id,
    displayName: p.display_name,
    speakLang: p.speak_lang,
    listenLang: p.listen_lang,
    esRegion: p.es_region,
    consentCurrent: p.consent_version === CONSENT_VERSION,
  };
}

async function audit(q: Queryable, kind: string, actorId: string | null, subjectId: string | null, detail: Record<string, unknown> = {}) {
  await q.query("insert into audit_events (gathering_id, kind, actor_id, subject_id, detail) values (null, $1, $2, $3, $4::text::jsonb)", [
    kind,
    actorId,
    subjectId,
    JSON.stringify(detail),
  ]);
}

// ------------------------------------------------------------------ people

/** The remembered person on this device, or null (no cookie, forgotten, or deleted). */
export async function currentPerson(req: Request): Promise<PersonRow | null> {
  const secret = parseCookies(req).get(PERSON_COOKIE);
  if (!secret || secret.length > 128) return null;
  const db = await getDb();
  const rows = await db.query<PersonRow & { device_id: string; device_seen: Date }>(
    `select p.*, d.id as device_id, d.last_seen_at as device_seen
       from person_devices d join people p on p.id = d.person_id
      where d.session_hash = $1`,
    [sha256Hex(secret)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.device_seen).getTime() > SEEN_WRITE_INTERVAL_MS) {
    await db.query("update person_devices set last_seen_at = now() where id = $1", [row.device_id]);
    await db.query("update people set last_seen_at = now() where id = $1", [row.id]);
  }
  const { device_id: _d, device_seen: _s, ...person } = row;
  void _d;
  void _s;
  return person;
}

export async function requirePerson(req: Request): Promise<PersonRow> {
  const p = await currentPerson(req);
  if (!p) throw new ApiError(401, "no_profile", "Set up your name and languages on this phone first");
  return p;
}

/** Saved consent must match the current consent text before audio flows again. */
export function requireCurrentConsent(p: PersonRow): void {
  if (p.consent_version !== CONSENT_VERSION) {
    throw new ApiError(409, "consent_required", "Please agree to live AI interpretation again (the terms changed)");
  }
}

export async function createPerson(
  input: LanguagePrefs & { displayName: string },
  ip: string,
): Promise<{ person: PersonRow; secret: string }> {
  const db = await getDb();
  await rateLimit(db, `person:${ip}`, 10, 600);
  const id = newId();
  const secret = newSessionSecret();
  await db.tx(async (t) => {
    await t.query(
      `insert into people (id, display_name, speak_lang, listen_lang, es_region, consent_version, consent_at)
       values ($1, $2, $3, $4, $5, $6, now())`,
      [id, input.displayName, input.speakLang, input.listenLang, input.esRegion, CONSENT_VERSION],
    );
    await t.query("insert into person_devices (id, person_id, session_hash) values ($1, $2, $3)", [newId(), id, sha256Hex(secret)]);
    await audit(t, "person_created", id, null);
  });
  const person = (await db.query<PersonRow>("select * from people where id = $1", [id]))[0];
  return { person, secret };
}

export async function updatePerson(
  person: PersonRow,
  patch: Partial<LanguagePrefs> & { displayName?: string; consent?: boolean },
): Promise<PersonRow> {
  const db = await getDb();
  await rateLimit(db, `person-edit:${person.id}`, 60, 600);
  const rows = await db.query<PersonRow>(
    `update people set display_name = $2, speak_lang = $3, listen_lang = $4, es_region = $5,
            consent_version = $6, consent_at = $7
      where id = $1 returning *`,
    [
      person.id,
      patch.displayName ?? person.display_name,
      patch.speakLang ?? person.speak_lang,
      patch.listenLang ?? person.listen_lang,
      patch.esRegion ?? person.es_region,
      patch.consent ? CONSENT_VERSION : person.consent_version,
      patch.consent ? new Date() : person.consent_at,
    ],
  );
  return rows[0];
}

/**
 * "Forget me on this phone": this device signs out. With no phone left there
 * is no way back into that profile, so it is deleted too (no ghost members).
 */
export async function forgetDevice(req: Request): Promise<void> {
  const secret = parseCookies(req).get(PERSON_COOKIE);
  if (!secret || secret.length > 128) return;
  const db = await getDb();
  const gone = await db.query<{ person_id: string }>("delete from person_devices where session_hash = $1 returning person_id", [
    sha256Hex(secret),
  ]);
  const personId = gone[0]?.person_id;
  if (!personId) return;
  const left = await db.query("select 1 from person_devices where person_id = $1", [personId]);
  if (left.length === 0) {
    const person = (await db.query<PersonRow>("select * from people where id = $1", [personId]))[0];
    if (person) await deletePerson(person);
  }
}

/** Delete the person everywhere: every phone, every table membership. */
export async function deletePerson(person: PersonRow): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const owned = await t.query<{ circle_id: string }>("select circle_id from circle_members where person_id = $1 and role = 'owner'", [
      person.id,
    ]);
    await t.query("delete from people where id = $1", [person.id]);
    for (const { circle_id } of owned) await promoteOwnerIfNeeded(t, circle_id);
    await t.query("delete from circles c where not exists (select 1 from circle_members m where m.circle_id = c.id)");
    await audit(t, "person_deleted", null, null);
  });
}

async function promoteOwnerIfNeeded(t: Queryable, tableId: string): Promise<void> {
  const rest = await t.query<{ person_id: string; role: string }>(
    "select person_id, role from circle_members where circle_id = $1 order by added_at asc, person_id asc",
    [tableId],
  );
  if (rest.length > 0 && !rest.some((r) => r.role === "owner")) {
    await t.query("update circle_members set role = 'owner' where circle_id = $1 and person_id = $2", [tableId, rest[0].person_id]);
  }
}

// ------------------------------------------------------------------ home

export async function homeView(person: PersonRow): Promise<HomeView> {
  const db = await getDb();
  const tables = await db.query<TableRow & { role: "owner" | "member" }>(
    `select c.*, m.role from circle_members m join circles c on c.id = m.circle_id
      where m.person_id = $1 order by c.last_used_at desc`,
    [person.id],
  );
  const ids = tables.map((t) => t.id);
  const members =
    ids.length === 0
      ? []
      : await db.query<{
          circle_id: string;
          id: string;
          display_name: string;
          speak_lang: SpeakLang;
          listen_lang: ListenLang;
          role: "owner" | "member";
        }>(
          `select m.circle_id, p.id, p.display_name, p.speak_lang, p.listen_lang, m.role
             from circle_members m join people p on p.id = m.person_id
            where m.circle_id = any($1::uuid[]) order by m.added_at asc, p.id asc`,
          [ids],
        );
  const seats =
    ids.length === 0
      ? []
      : await db.query<{ circle_id: string; gathering_id: string; display_name: string | null; person_id: string | null; online: boolean | null }>(
          `select g.circle_id, g.id as gathering_id, p.display_name, p.person_id,
                  (p.last_seen_at > now() - ($3 || ' seconds')::interval) as online
             from gatherings g
             left join participants p on p.gathering_id = g.id and p.left_at is null and p.kicked_at is null
            where g.circle_id = any($1::uuid[]) and g.ended_at is null and g.expires_at > now()
              and g.last_activity_at > now() - ($2 || ' minutes')::interval
            order by g.created_at desc`,
          [ids, String(config.idleEndMinutes), String(ONLINE_WINDOW_SECONDS)],
        );

  const live = new Map<string, NonNullable<TableView["live"]>>();
  for (const s of seats) {
    let entry = live.get(s.circle_id);
    if (!entry) {
      entry = { gatheringId: s.gathering_id, onlineNames: [], meIn: false };
      live.set(s.circle_id, entry);
    }
    if (entry.gatheringId !== s.gathering_id || !s.display_name) continue; // only the newest session counts
    if (s.person_id === person.id) entry.meIn = true;
    else if (s.online) entry.onlineNames.push(s.display_name);
  }

  const views: TableView[] = [];
  for (const t of tables) {
    views.push({
      id: t.id,
      name: t.name,
      role: t.role,
      members: members
        .filter((m) => m.circle_id === t.id)
        .map((m) => ({ id: m.id, displayName: m.display_name, speakLang: m.speak_lang, role: m.role, isMe: m.id === person.id })),
      inviteUrlPath: tableInviteUrlPath(t.id, await tableInviteTokenFor(db, t)),
      live: live.get(t.id) ?? null,
    });
  }

  const contacts = new Map<string, ContactView>();
  for (const m of members) {
    if (m.id === person.id) continue;
    const tableName = tables.find((t) => t.id === m.circle_id)?.name ?? "";
    const c = contacts.get(m.id);
    if (c) {
      if (!c.tableNames.includes(tableName)) c.tableNames.push(tableName);
    } else {
      contacts.set(m.id, { id: m.id, displayName: m.display_name, speakLang: m.speak_lang, listenLang: m.listen_lang, tableNames: [tableName] });
    }
  }

  return {
    person: personView(person),
    tables: views,
    people: [...contacts.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

// ------------------------------------------------------------------ tables

export async function createTable(
  person: PersonRow,
  input: { name: string; memberIds: string[]; hostCode?: string },
  ip: string,
): Promise<{ id: string }> {
  assertMayCreate(input.hostCode);
  requireCurrentConsent(person);
  const db = await getDb();
  await rateLimit(db, `table:${person.id}`, 10, 600);
  await rateLimit(db, `create:${ip}`, 10, 600);
  const id = newId();
  await db.tx(async (t) => {
    const mine = (await t.query<{ n: number }>("select count(*)::int as n from circle_members where person_id = $1", [person.id]))[0];
    if (Number(mine.n) >= MAX_TABLES_PER_PERSON) {
      throw new ApiError(409, "too_many_tables", `You can keep up to ${MAX_TABLES_PER_PERSON} tables. Leave one first.`);
    }
    const wanted = [...new Set(input.memberIds)].filter((m) => m !== person.id).slice(0, MAX_TABLE_MEMBERS - 1);
    // Only people you already share a table with can be added without a link.
    const contacts =
      wanted.length === 0
        ? []
        : await t.query<{ person_id: string }>(
            `select distinct m2.person_id from circle_members m1
               join circle_members m2 on m2.circle_id = m1.circle_id
              where m1.person_id = $1 and m2.person_id = any($2::uuid[])`,
            [person.id, wanted],
          );
    if (contacts.length !== wanted.length) {
      throw new ApiError(400, "not_a_contact", "You can only add people you already share a table with");
    }
    await t.query("insert into circles (id, name, created_by) values ($1, $2, $3)", [id, input.name, person.id]);
    await t.query("insert into circle_members (circle_id, person_id, role) values ($1, $2, 'owner')", [id, person.id]);
    for (const c of contacts) {
      await t.query("insert into circle_members (circle_id, person_id, role) values ($1, $2, 'member')", [id, c.person_id]);
    }
    await audit(t, "table_created", person.id, id, { members: contacts.length + 1 });
  });
  return { id };
}

/** Membership check; a non-member gets the same 404 as a table that does not exist. */
export async function requireMembership(person: PersonRow, tableId: string): Promise<"owner" | "member"> {
  const db = await getDb();
  const rows = await db.query<{ role: "owner" | "member" }>("select role from circle_members where circle_id = $1 and person_id = $2", [
    tableId,
    person.id,
  ]);
  if (!rows[0]) throw new ApiError(404, "table_not_found", "That table is not in your list");
  return rows[0].role;
}

async function requireOwner(person: PersonRow, tableId: string): Promise<void> {
  if ((await requireMembership(person, tableId)) !== "owner") {
    throw new ApiError(403, "not_owner", "Only the person who looks after this table can do that");
  }
}

/** Check a table link. Unknown table and wrong token look identical (no oracle). */
export async function verifyTableInvite(tableId: string, token: unknown, ip: string): Promise<TableRow> {
  const db = await getDb();
  await rateLimit(db, `join:${ip}`, 30, 600);
  const invalid = new ApiError(403, "invalid_invite", "This table link is not valid any more. Ask someone at the table for the new one.");
  if (typeof token !== "string" || token.length < 16 || token.length > 64) throw invalid;
  const table = (await db.query<TableRow>("select * from circles where id = $1", [tableId]))[0];
  if (!table) throw invalid;
  if (!safeEqual(await tableInviteTokenFor(db, table), token)) {
    await audit(db, "table_join_denied_bad_invite", null, tableId, { ip_hash: sha256Hex(ip).slice(0, 16) });
    throw invalid;
  }
  return table;
}

/** What someone holding a valid link sees before joining. */
export async function previewTable(tableId: string, token: unknown, ip: string): Promise<TablePreview> {
  const table = await verifyTableInvite(tableId, token, ip);
  const db = await getDb();
  const members = await db.query<{ display_name: string }>(
    "select p.display_name from circle_members m join people p on p.id = m.person_id where m.circle_id = $1 order by m.added_at asc",
    [tableId],
  );
  const online = await db.query<{ display_name: string }>(
    `select p.display_name from gatherings g join participants p on p.gathering_id = g.id
      where g.circle_id = $1 and g.ended_at is null and g.expires_at > now()
        and p.left_at is null and p.kicked_at is null
        and p.last_seen_at > now() - ($2 || ' seconds')::interval`,
    [tableId, String(ONLINE_WINDOW_SECONDS)],
  );
  return { name: table.name, memberNames: members.map((m) => m.display_name), onlineNames: online.map((o) => o.display_name) };
}

/** Add a person who opened a valid table link. No-op if already a member. */
export async function addTableMember(tableId: string, person: PersonRow): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const table = await t.query("select id from circles where id = $1 for update", [tableId]);
    if (!table[0]) throw new ApiError(404, "table_not_found", "This table no longer exists");
    const already = await t.query("select 1 from circle_members where circle_id = $1 and person_id = $2", [tableId, person.id]);
    if (already.length > 0) return;
    const n = (await t.query<{ n: number }>("select count(*)::int as n from circle_members where circle_id = $1", [tableId]))[0];
    if (Number(n.n) >= MAX_TABLE_MEMBERS) throw new ApiError(409, "table_full", `A table can keep up to ${MAX_TABLE_MEMBERS} people`);
    const mine = (await t.query<{ n: number }>("select count(*)::int as n from circle_members where person_id = $1", [person.id]))[0];
    if (Number(mine.n) >= MAX_TABLES_PER_PERSON) {
      throw new ApiError(409, "too_many_tables", `You can keep up to ${MAX_TABLES_PER_PERSON} tables. Leave one first.`);
    }
    await t.query("insert into circle_members (circle_id, person_id, role) values ($1, $2, 'member')", [tableId, person.id]);
    await audit(t, "table_joined", person.id, tableId);
  });
}

/** Take a table off your list. The last person out deletes the table. */
export async function leaveTable(person: PersonRow, tableId: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query("select id from circles where id = $1 for update", [tableId]);
    const gone = await t.query("delete from circle_members where circle_id = $1 and person_id = $2 returning role", [tableId, person.id]);
    if (gone.length === 0) throw new ApiError(404, "table_not_found", "That table is not in your list");
    await promoteOwnerIfNeeded(t, tableId);
    await t.query("delete from circles c where c.id = $1 and not exists (select 1 from circle_members m where m.circle_id = c.id)", [tableId]);
    await audit(t, "table_left", person.id, tableId);
  });
}

/**
 * The table's owner removes someone. Their seat in the live gathering ends and
 * the table link is replaced, so the old link cannot bring them back.
 */
export async function removeTableMember(owner: PersonRow, tableId: string, personId: string): Promise<string> {
  if (personId === owner.id) throw new ApiError(400, "use_leave", "Use “Leave this table” to remove yourself");
  await requireOwner(owner, tableId);
  const db = await getDb();
  const rows = await db.tx(async (t) => {
    const gone = await t.query("delete from circle_members where circle_id = $1 and person_id = $2 returning person_id", [tableId, personId]);
    if (gone.length === 0) throw new ApiError(404, "member_not_found", "That person is not at this table");
    const bumped = await t.query<TableRow>("update circles set invite_version = invite_version + 1 where id = $1 returning *", [tableId]);
    await audit(t, "table_member_removed", owner.id, personId, { table: tableId });
    return bumped;
  });
  await evictPersonFromTableGathering(tableId, personId);
  return tableInviteUrlPath(tableId, await tableInviteTokenFor(db, rows[0]));
}

export async function rotateTableInvite(owner: PersonRow, tableId: string): Promise<string> {
  await requireOwner(owner, tableId);
  const db = await getDb();
  const rows = await db.query<TableRow>("update circles set invite_version = invite_version + 1 where id = $1 returning *", [tableId]);
  await audit(db, "table_invite_rotated", owner.id, tableId);
  return tableInviteUrlPath(tableId, await tableInviteTokenFor(db, rows[0]));
}

export async function renameTable(owner: PersonRow, tableId: string, name: string): Promise<void> {
  await requireOwner(owner, tableId);
  const db = await getDb();
  await db.query("update circles set name = $2 where id = $1", [tableId, name]);
}

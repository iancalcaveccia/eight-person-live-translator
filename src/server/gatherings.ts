/**
 * Gathering / group / membership domain logic. This module is the privacy
 * boundary: every authorization decision for media rooms is made here, from
 * Postgres state, never from client-supplied room names.
 *
 * Invariants:
 *  - A participant has exactly one active group (`active_group_id`) and an
 *    `active_epoch` that increments on every move.
 *  - Media tokens are minted only for the room of the caller's active group.
 *  - The main group is open to every admitted participant; private groups
 *    require a `group_members` row.
 *  - Leaving a private group (including moving elsewhere) drops membership;
 *    a private group with no members is closed.
 */
import "server-only";
import { ATTR } from "@/lib/contract";
import type {
  BudgetView,
  GatheringStateView,
  GroupView,
  InvitationView,
  MediaTokenView,
  ParticipantView,
} from "@/lib/api-types";
import type { EsRegion, ListenLang, SpeakLang } from "@/lib/languages";
import { getDb, type Queryable } from "./db";
import { config, CONSENT_VERSION, isHostedDeployment } from "./env";
import {
  deriveInviteToken,
  newId,
  newRoomName,
  newSessionSecret,
  randomBase32,
  safeEqual,
  sha256Hex,
} from "./crypto";
import { ApiError, parseCookies, sessionCookieName } from "./http";
import { bestEffort, getMediaAdmin } from "./livekit";
import { rateLimit } from "./ratelimit";
import { estimateCostUsd } from "./costs";
import type { LanguagePrefs } from "./validation";

// ------------------------------------------------------------------ row types

export interface GatheringRow {
  id: string;
  title: string;
  invite_version: number;
  host_participant_id: string | null;
  max_humans: number;
  budget_usd: number;
  spent_usd: number;
  default_provider: string;
  version: number;
  created_at: Date;
  expires_at: Date;
  ended_at: Date | null;
  last_activity_at: Date;
}

export interface ParticipantRow {
  id: string;
  gathering_id: string;
  display_name: string;
  speak_lang: SpeakLang;
  listen_lang: ListenLang;
  es_region: EsRegion;
  role: "host" | "guest";
  color: number;
  session_hash: string;
  active_group_id: string | null;
  active_epoch: number;
  joined_at: Date;
  last_seen_at: Date;
  left_at: Date | null;
  kicked_at: Date | null;
}

export interface GroupRow {
  id: string;
  gathering_id: string;
  kind: "main" | "private";
  name: string;
  livekit_room: string;
  created_by: string | null;
  created_at: Date;
  closed_at: Date | null;
}

export interface AuthContext {
  gathering: GatheringRow;
  me: ParticipantRow;
}

const ONLINE_WINDOW_MS = 25_000;
const MAX_PRIVATE_GROUPS = 8;
const LAST_SEEN_WRITE_INTERVAL_MS = 10_000;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ------------------------------------------------------------- app secret

async function getAppSecret(q: Queryable): Promise<string> {
  const fromEnv = config.appSecret;
  if (fromEnv) return fromEnv;
  const rows = await q.query<{ value: string }>("select value from app_settings where key = 'app_secret'");
  if (rows[0]) return rows[0].value;
  const value = randomBase32(48);
  await q.query("insert into app_settings (key, value) values ('app_secret', $1) on conflict (key) do nothing", [value]);
  if (isHostedDeployment()) {
    console.warn("[config] APP_SECRET not set; using a database-stored invite secret");
  }
  const again = await q.query<{ value: string }>("select value from app_settings where key = 'app_secret'");
  return again[0].value;
}

export async function inviteTokenFor(q: Queryable, g: GatheringRow): Promise<string> {
  return deriveInviteToken(await getAppSecret(q), g.id, g.invite_version);
}

export function inviteUrlPath(gatheringId: string, token: string): string {
  // Token in the fragment: never sent to servers, proxies or Referer headers.
  return `/g/${gatheringId}/join#k=${token}`;
}

// --------------------------------------------------------------- helpers

async function audit(
  q: Queryable,
  gatheringId: string | null,
  kind: string,
  actorId: string | null,
  subjectId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    "insert into audit_events (gathering_id, kind, actor_id, subject_id, detail) values ($1, $2, $3, $4, $5::jsonb)",
    [gatheringId, kind, actorId, subjectId, JSON.stringify(detail)],
  );
}

async function bumpVersion(q: Queryable, gatheringId: string): Promise<void> {
  await q.query("update gatherings set version = version + 1, last_activity_at = now() where id = $1", [gatheringId]);
}

async function activeParticipants(q: Queryable, gatheringId: string): Promise<ParticipantRow[]> {
  return q.query<ParticipantRow>(
    `select * from participants
     where gathering_id = $1 and left_at is null and kicked_at is null
     order by joined_at asc`,
    [gatheringId],
  );
}

async function mainGroup(q: Queryable, gatheringId: string): Promise<GroupRow> {
  const rows = await q.query<GroupRow>("select * from groups where gathering_id = $1 and kind = 'main'", [gatheringId]);
  if (!rows[0]) throw new ApiError(500, "missing_main_group");
  return rows[0];
}

async function groupById(q: Queryable, gatheringId: string, groupId: string): Promise<GroupRow> {
  const rows = await q.query<GroupRow>("select * from groups where id = $1 and gathering_id = $2", [groupId, gatheringId]);
  // Same error for "does not exist" and "exists in another gathering".
  if (!rows[0] || rows[0].closed_at) throw new ApiError(404, "group_not_found", "That conversation is not available");
  return rows[0];
}

async function isMember(q: Queryable, groupId: string, participantId: string): Promise<boolean> {
  const rows = await q.query("select 1 from group_members where group_id = $1 and participant_id = $2", [
    groupId,
    participantId,
  ]);
  return rows.length > 0;
}

function participantAttributes(p: ParticipantRow, group: GroupRow, epoch: number): Record<string, string> {
  return {
    [ATTR.version]: "1",
    [ATTR.speakLang]: p.speak_lang,
    [ATTR.listenLang]: p.listen_lang,
    [ATTR.esRegion]: p.es_region,
    [ATTR.role]: p.role,
    [ATTR.color]: String(p.color),
    [ATTR.gatheringId]: p.gathering_id,
    [ATTR.groupId]: group.id,
    [ATTR.epoch]: String(epoch),
  };
}

function pickColor(used: number[]): number {
  for (let i = 0; i < 8; i++) if (!used.includes(i)) return i;
  return used.length % 8;
}

// ----------------------------------------------------------- authentication

/** Resolve the caller's participant from the gathering session cookie. */
export async function authenticate(req: Request, gatheringId: string): Promise<AuthContext> {
  const secret = parseCookies(req).get(sessionCookieName(gatheringId));
  if (!secret) throw new ApiError(401, "not_joined", "Join this gathering with an invite link first");
  const db = await getDb();
  const rows = await db.query<ParticipantRow & { g: GatheringRow }>(
    `select p.*, row_to_json(g.*) as g
       from participants p join gatherings g on g.id = p.gathering_id
      where p.session_hash = $1 and p.gathering_id = $2`,
    [sha256Hex(secret), gatheringId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(401, "not_joined", "This gathering has ended or your session is no longer valid");
  const { g, ...me } = row;
  const gathering = normaliseGathering(g as unknown as Record<string, unknown>);
  if (me.kicked_at) throw new ApiError(403, "kicked", "The host removed you from this gathering");
  if (me.left_at) throw new ApiError(401, "left", "You left this gathering");
  if (gathering.ended_at) throw new ApiError(410, "gathering_ended", "This gathering has ended");

  const ended = await maybeAutoEnd(gathering);
  if (ended) throw new ApiError(410, "gathering_ended", "This gathering has ended");

  // Presence heartbeat (throttled writes).
  if (Date.now() - new Date(me.last_seen_at).getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
    await db.query("update participants set last_seen_at = now() where id = $1", [me.id]);
    await db.query("update gatherings set last_activity_at = now() where id = $1", [gathering.id]);
    me.last_seen_at = new Date();
  }
  return { gathering, me: me as ParticipantRow };
}

/** row_to_json returns timestamps as strings; normalise to Dates. */
function normaliseGathering(g: Record<string, unknown>): GatheringRow {
  const d = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return {
    ...(g as unknown as GatheringRow),
    budget_usd: Number(g.budget_usd),
    spent_usd: Number(g.spent_usd),
    version: Number(g.version),
    invite_version: Number(g.invite_version),
    max_humans: Number(g.max_humans),
    created_at: d(g.created_at)!,
    expires_at: d(g.expires_at)!,
    ended_at: d(g.ended_at),
    last_activity_at: d(g.last_activity_at)!,
  };
}

/** Ends expired or abandoned gatherings. Returns true if it ended. */
async function maybeAutoEnd(g: GatheringRow): Promise<boolean> {
  const now = Date.now();
  if (now > g.expires_at.getTime()) {
    await endGatheringInternal(g.id, "expired", null);
    return true;
  }
  if (now - g.last_activity_at.getTime() > config.idleEndMinutes * 60_000) {
    await endGatheringInternal(g.id, "idle", null);
    return true;
  }
  return false;
}

// ------------------------------------------------------- create & join

export interface CreateGatheringInput extends LanguagePrefs {
  hostCode: string | undefined;
  title: string;
  displayName: string;
  budgetUsd?: number;
}

export interface JoinResult {
  gatheringId: string;
  participantId: string;
  sessionSecret: string;
  cookieMaxAgeSeconds: number;
  inviteUrlPath: string;
}

export function hostCodeRequired(): boolean {
  return Boolean(config.hostAccessCode) || isHostedDeployment();
}

export async function createGathering(input: CreateGatheringInput, ip: string): Promise<JoinResult> {
  const required = config.hostAccessCode;
  if (required) {
    if (!input.hostCode || !safeEqual(input.hostCode, required)) {
      throw new ApiError(403, "bad_host_code", "That host access code is not correct");
    }
  } else if (isHostedDeployment()) {
    throw new ApiError(503, "host_code_not_configured", "Set HOST_ACCESS_CODE on the server to allow creating gatherings");
  }

  const db = await getDb();
  await rateLimit(db, `create:${ip}`, 10, 600);

  const cap = config.maxSpendPerGatheringUsd;
  const budget = Math.min(cap, input.budgetUsd && input.budgetUsd > 0 ? input.budgetUsd : cap);
  const gatheringId = newId();
  const participantId = newId();
  const sessionSecret = newSessionSecret();
  const lifetimeSeconds = config.maxGatheringMinutes * 60;

  await db.tx(async (t) => {
    await t.query(
      `insert into gatherings (id, title, host_participant_id, max_humans, budget_usd, default_provider, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
      [gatheringId, input.title, participantId, config.maxHumans, budget, config.defaultProvider, String(lifetimeSeconds)],
    );
    const mainId = newId();
    await t.query(
      "insert into groups (id, gathering_id, kind, name, livekit_room, created_by) values ($1, $2, 'main', $3, $4, $5)",
      [mainId, gatheringId, "Main conversation", newRoomName(), participantId],
    );
    await t.query(
      `insert into participants
         (id, gathering_id, display_name, speak_lang, listen_lang, es_region, role, color,
          session_hash, consent_version, consent_at, active_group_id)
       values ($1, $2, $3, $4, $5, $6, 'host', 0, $7, $8, now(), $9)`,
      [
        participantId,
        gatheringId,
        input.displayName,
        input.speakLang,
        input.listenLang,
        input.esRegion,
        sha256Hex(sessionSecret),
        CONSENT_VERSION,
        mainId,
      ],
    );
    await audit(t, gatheringId, "gathering_created", participantId, null);
  });

  const g = (await db.query<GatheringRow>("select * from gatherings where id = $1", [gatheringId]))[0];
  return {
    gatheringId,
    participantId,
    sessionSecret,
    cookieMaxAgeSeconds: lifetimeSeconds,
    inviteUrlPath: inviteUrlPath(gatheringId, await inviteTokenFor(db, g)),
  };
}

export interface JoinInput extends LanguagePrefs {
  inviteToken: string;
  displayName: string;
}

export async function joinGathering(gatheringId: string, input: JoinInput, ip: string): Promise<JoinResult> {
  const db = await getDb();
  await rateLimit(db, `join:${ip}`, 30, 600);

  const sessionSecret = newSessionSecret();
  const participantId = newId();

  const result = await db.tx(async (t) => {
    const gs = await t.query<GatheringRow>("select * from gatherings where id = $1 for update", [gatheringId]);
    const g = gs[0];
    // Identical response for unknown gathering and wrong token: no oracle.
    const invalid = new ApiError(403, "invalid_invite", "This invite link is not valid. Ask the host for a new one.");
    if (!g) throw invalid;
    const expected = await inviteTokenFor(t, g);
    if (!safeEqual(expected, input.inviteToken)) {
      await audit(t, gatheringId, "join_denied_bad_invite", null, null, { ip_hash: sha256Hex(ip).slice(0, 16) });
      throw invalid;
    }
    if (g.ended_at || new Date(g.expires_at).getTime() < Date.now()) {
      throw new ApiError(410, "gathering_ended", "This gathering has ended");
    }
    const present = await activeParticipants(t, gatheringId);
    if (present.length >= g.max_humans) {
      throw new ApiError(409, "gathering_full", `This gathering already has ${g.max_humans} people`);
    }
    const main = await mainGroup(t, gatheringId);
    const color = pickColor(present.map((p) => p.color));
    await t.query(
      `insert into participants
         (id, gathering_id, display_name, speak_lang, listen_lang, es_region, role, color,
          session_hash, consent_version, consent_at, active_group_id)
       values ($1, $2, $3, $4, $5, $6, 'guest', $7, $8, $9, now(), $10)`,
      [
        participantId,
        gatheringId,
        input.displayName,
        input.speakLang,
        input.listenLang,
        input.esRegion,
        color,
        sha256Hex(sessionSecret),
        CONSENT_VERSION,
        main.id,
      ],
    );
    await bumpVersion(t, gatheringId);
    await audit(t, gatheringId, "participant_joined", participantId, null);
    const remainingSeconds = Math.max(60, Math.floor((new Date(g.expires_at).getTime() - Date.now()) / 1000));
    return { g, main, remainingSeconds, others: present };
  });

  // Nudge everyone in main so the newcomer appears immediately.
  const admin = getMediaAdmin();
  const inMain = result.others.filter((p) => p.active_group_id === result.main.id).map((p) => p.id);
  await bestEffort("nudge join", () => admin.sendData(result.main.livekit_room, inMain, { t: "refresh" }, "interp.control"));

  return {
    gatheringId,
    participantId,
    sessionSecret,
    cookieMaxAgeSeconds: result.remainingSeconds,
    inviteUrlPath: inviteUrlPath(gatheringId, input.inviteToken),
  };
}

// --------------------------------------------------------------- budget

export async function budgetFor(q: Queryable, g: GatheringRow): Promise<BudgetView> {
  const rows = await q.query<{ day: number; month: number }>(
    `select
       coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day', now())), 0) as day,
       coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now())), 0) as month
     from usage_records where created_at >= date_trunc('month', now())`,
  );
  const day = Number(rows[0]?.day ?? 0);
  const month = Number(rows[0]?.month ?? 0);
  const gatheringUsd = Number(g.spent_usd);
  const gatheringCap = Number(g.budget_usd);
  const dayCap = config.maxSpendDailyUsd ?? null;
  const monthCap = config.maxSpendMonthlyUsd;

  let reason: string | null = null;
  if (g.ended_at) reason = "gathering_ended";
  else if (gatheringUsd >= gatheringCap) reason = "gathering_cap";
  else if (month >= monthCap) reason = "monthly_cap";
  else if (dayCap !== null && day >= dayCap) reason = "daily_cap";

  const ratio = config.spendWarningRatio;
  const warning =
    !reason &&
    (gatheringUsd >= gatheringCap * ratio || month >= monthCap * ratio || (dayCap !== null && day >= dayCap * ratio));

  return {
    gatheringUsd: round(gatheringUsd),
    gatheringCapUsd: gatheringCap,
    dayUsd: round(day),
    dayCapUsd: dayCap,
    monthUsd: round(month),
    monthCapUsd: monthCap,
    translationAllowed: reason === null,
    reason,
    warning,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

// ------------------------------------------------------------------ state

export async function getState(ctx: AuthContext): Promise<GatheringStateView> {
  const db = await getDb();
  const { gathering: g, me } = ctx;
  const people = await activeParticipants(db, g.id);
  const groups = await db.query<GroupRow>(
    "select * from groups where gathering_id = $1 and closed_at is null order by created_at asc",
    [g.id],
  );
  const memberships = await db.query<{ group_id: string; participant_id: string; role: "owner" | "member" }>(
    `select gm.group_id, gm.participant_id, gm.role from group_members gm
       join groups gr on gr.id = gm.group_id
      where gr.gathering_id = $1 and gr.closed_at is null`,
    [g.id],
  );
  const myGroupIds = new Set(memberships.filter((m) => m.participant_id === me.id).map((m) => m.group_id));
  const nameOf = new Map(people.map((p) => [p.id, p.display_name]));
  const visible = (gr: GroupRow) => gr.kind === "main" || myGroupIds.has(gr.id);

  const groupViews: GroupView[] = groups.filter(visible).map((gr) => {
    const members =
      gr.kind === "private"
        ? memberships
            .filter((m) => m.group_id === gr.id && nameOf.has(m.participant_id))
            .map((m) => ({ id: m.participant_id, displayName: nameOf.get(m.participant_id)!, role: m.role }))
        : [];
    return {
      id: gr.id,
      kind: gr.kind,
      name: gr.name,
      isMember: gr.kind === "main" || myGroupIds.has(gr.id),
      isOwner: members.some((m) => m.id === me.id && m.role === "owner"),
      members,
      activeIds: people.filter((p) => p.active_group_id === gr.id).map((p) => p.id),
    };
  });
  const groupById = new Map(groups.map((gr) => [gr.id, gr]));

  const participants: ParticipantView[] = people.map((p) => {
    const gr = p.active_group_id ? groupById.get(p.active_group_id) : undefined;
    let location: ParticipantView["location"] = { type: "none" };
    if (gr) {
      location = visible(gr) ? { type: "group", groupId: gr.id, groupName: gr.name, kind: gr.kind } : { type: "private" };
    }
    return {
      id: p.id,
      displayName: p.display_name,
      color: p.color,
      speakLang: p.speak_lang,
      listenLang: p.listen_lang,
      esRegion: p.es_region,
      role: p.role,
      online: Date.now() - new Date(p.last_seen_at).getTime() < ONLINE_WINDOW_MS,
      location,
    };
  });

  const invRows = await db.query<{
    id: string;
    group_id: string;
    group_name: string;
    from_participant_id: string;
    created_at: Date;
  }>(
    `select i.id, i.group_id, gr.name as group_name, i.from_participant_id, i.created_at
       from invitations i join groups gr on gr.id = i.group_id
      where i.to_participant_id = $1 and i.status = 'pending' and gr.closed_at is null
      order by i.created_at desc`,
    [me.id],
  );
  const invitations: InvitationView[] = invRows.map((i) => ({
    id: i.id,
    groupId: i.group_id,
    groupName: i.group_name,
    fromId: i.from_participant_id,
    fromName: nameOf.get(i.from_participant_id) ?? "Someone",
    memberNames: memberships
      .filter((m) => m.group_id === i.group_id)
      .map((m) => nameOf.get(m.participant_id))
      .filter((n): n is string => Boolean(n)),
    createdAt: iso(i.created_at)!,
  }));

  const outRows = await db.query<{ id: string; group_id: string; to_participant_id: string }>(
    `select i.id, i.group_id, i.to_participant_id from invitations i
       join groups gr on gr.id = i.group_id
      where i.from_participant_id = $1 and i.status = 'pending' and gr.closed_at is null`,
    [me.id],
  );

  return {
    version: Number(g.version),
    serverTime: new Date().toISOString(),
    gathering: {
      id: g.id,
      title: g.title,
      createdAt: iso(g.created_at)!,
      expiresAt: iso(g.expires_at)!,
      hostId: g.host_participant_id,
      maxHumans: g.max_humans,
      inviteUrlPath: inviteUrlPath(g.id, await inviteTokenFor(db, g)),
    },
    me: {
      id: me.id,
      displayName: me.display_name,
      speakLang: me.speak_lang,
      listenLang: me.listen_lang,
      esRegion: me.es_region,
      role: me.role,
      color: me.color,
      activeGroupId: me.active_group_id,
      epoch: me.active_epoch,
    },
    participants,
    groups: groupViews,
    invitations,
    outgoingInvitations: outRows.map((o) => ({
      id: o.id,
      groupId: o.group_id,
      toId: o.to_participant_id,
      toName: nameOf.get(o.to_participant_id) ?? "Someone",
    })),
    budget: await budgetFor(db, g),
  };
}

// ------------------------------------------------------------ preferences

export async function updatePreferences(
  ctx: AuthContext,
  patch: Partial<LanguagePrefs> & { displayName?: string },
): Promise<void> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  const next = {
    display_name: patch.displayName ?? ctx.me.display_name,
    speak_lang: patch.speakLang ?? ctx.me.speak_lang,
    listen_lang: patch.listenLang ?? ctx.me.listen_lang,
    es_region: patch.esRegion ?? ctx.me.es_region,
  };
  const rows = await db.query<ParticipantRow>(
    `update participants set display_name = $2, speak_lang = $3, listen_lang = $4, es_region = $5
      where id = $1 returning *`,
    [ctx.me.id, next.display_name, next.speak_lang, next.listen_lang, next.es_region],
  );
  await bumpVersion(db, ctx.gathering.id);
  const p = rows[0];
  if (!p.active_group_id) return;
  const gr = await groupById(db, ctx.gathering.id, p.active_group_id);
  const admin = getMediaAdmin();
  // Server-authoritative attributes: the worker re-routes translation on change.
  await bestEffort("update attributes", () =>
    admin.updateAttributes(gr.livekit_room, p.id, participantAttributes(p, gr, p.active_epoch)),
  );
}

// ------------------------------------------------------------ media token

export async function mintMediaToken(ctx: AuthContext): Promise<MediaTokenView> {
  const db = await getDb();
  await rateLimit(db, `token:${ctx.me.id}`, 60, 600);
  const admin = getMediaAdmin();
  if (!admin.configured) {
    throw new ApiError(503, "media_not_configured", "LiveKit is not configured on this server yet");
  }
  // Re-read inside the call so a concurrent move can't hand out a stale room.
  let me = (await db.query<ParticipantRow>("select * from participants where id = $1", [ctx.me.id]))[0];
  let gr: GroupRow | undefined = me.active_group_id
    ? (await db.query<GroupRow>("select * from groups where id = $1 and closed_at is null", [me.active_group_id]))[0]
    : undefined;
  const privateButNotMember = gr?.kind === "private" && !(await isMember(db, gr.id, me.id));
  if (!gr || privateButNotMember) {
    // Defensive self-heal: never mint for a closed/unauthorized group; fall back to main.
    const main = await mainGroup(db, ctx.gathering.id);
    const outcome = await db.tx((t) => moveInTx(t, ctx.gathering.id, me.id, main, me.id, "heal_to_main"));
    await applyMoveEffects(me.id, outcome, false, main.id);
    me = (await db.query<ParticipantRow>("select * from participants where id = $1", [ctx.me.id]))[0];
    gr = main;
  }
  const ttl = config.mediaTokenTtlSeconds;
  const token = await admin.mintToken({
    room: gr.livekit_room,
    identity: me.id,
    name: me.display_name,
    attributes: participantAttributes(me, gr, me.active_epoch),
    dispatchMetadata: { v: 1, gatheringId: ctx.gathering.id, groupId: gr.id, room: gr.livekit_room },
    ttlSeconds: ttl,
  });
  await audit(db, ctx.gathering.id, "media_token_issued", me.id, null, { group: gr.id, epoch: me.active_epoch });
  return {
    token,
    serverUrl: admin.serverUrl,
    room: gr.livekit_room,
    groupId: gr.id,
    epoch: me.active_epoch,
    expiresInSeconds: ttl,
  };
}

// ------------------------------------------------------------------ moves

interface MoveOutcome {
  fromRoom: string | null;
  toRoom: string;
  stayedIdentities: string[]; // remaining people in the old room
  joinedIdentities: string[]; // people already in the new room
  closedGroupRoom: string | null;
}

/**
 * Move `participantId` into `target` inside an open transaction. Caller must
 * have verified authorization. Increments the epoch so older tokens become
 * stale for admission, drops private membership of the group being left and
 * closes it when empty.
 */
async function moveInTx(
  t: Queryable,
  gatheringId: string,
  participantId: string,
  target: GroupRow,
  actorId: string,
  reason: string,
): Promise<MoveOutcome> {
  const rows = await t.query<ParticipantRow>("select * from participants where id = $1 for update", [participantId]);
  const p = rows[0];
  if (!p || p.left_at || p.kicked_at) throw new ApiError(404, "participant_not_found");

  let fromRoom: string | null = null;
  let closedGroupRoom: string | null = null;
  let stayed: string[] = [];
  if (p.active_group_id && p.active_group_id !== target.id) {
    const old = (await t.query<GroupRow>("select * from groups where id = $1", [p.active_group_id]))[0];
    if (old) {
      fromRoom = old.livekit_room;
      if (old.kind === "private") {
        await t.query("delete from group_members where group_id = $1 and participant_id = $2", [old.id, p.id]);
        const left = await t.query("select 1 from group_members where group_id = $1", [old.id]);
        if (left.length === 0) {
          await t.query("update groups set closed_at = now() where id = $1", [old.id]);
          await t.query("update invitations set status = 'revoked', responded_at = now() where group_id = $1 and status = 'pending'", [old.id]);
          closedGroupRoom = old.livekit_room;
        }
      }
      stayed = (
        await t.query<{ id: string }>(
          "select id from participants where active_group_id = $1 and id <> $2 and left_at is null and kicked_at is null",
          [old.id, p.id],
        )
      ).map((r) => r.id);
    }
  }
  const joined = (
    await t.query<{ id: string }>(
      "select id from participants where active_group_id = $1 and id <> $2 and left_at is null and kicked_at is null",
      [target.id, p.id],
    )
  ).map((r) => r.id);

  if (p.active_group_id !== target.id) {
    await t.query("update participants set active_group_id = $2, active_epoch = active_epoch + 1 where id = $1", [
      p.id,
      target.id,
    ]);
    await audit(t, gatheringId, "group_move", actorId, p.id, { from: p.active_group_id, to: target.id, reason });
  }
  await bumpVersion(t, gatheringId);
  return { fromRoom, toRoom: target.livekit_room, stayedIdentities: stayed, joinedIdentities: joined, closedGroupRoom };
}

/** Post-commit media side effects of a move. Old room participation is cut first. */
async function applyMoveEffects(participantId: string, o: MoveOutcome, notifyMover: boolean, groupId: string) {
  const admin = getMediaAdmin();
  if (o.fromRoom) {
    // Server-side eviction: the old room stops receiving this mic even if the
    // client misbehaves or keeps the old connection open.
    await bestEffort("evict from old room", () => admin.removeParticipant(o.fromRoom!, participantId));
    await bestEffort("nudge old room", () => admin.sendData(o.fromRoom!, o.stayedIdentities, { t: "refresh" }, "interp.control"));
  }
  if (notifyMover && o.fromRoom) {
    // Mover may still be connected elsewhere (another tab); tell it to follow.
    await bestEffort("nudge mover", () => admin.sendData(o.fromRoom!, [participantId], { t: "moved", groupId }, "interp.control"));
  }
  await bestEffort("nudge new room", () => admin.sendData(o.toRoom, o.joinedIdentities, { t: "refresh" }, "interp.control"));
  if (o.closedGroupRoom) {
    await bestEffort("delete empty room", () => admin.deleteRoom(o.closedGroupRoom!));
  }
}

export async function enterGroup(ctx: AuthContext, groupId: string): Promise<MediaTokenView> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  let outcome: MoveOutcome | null = null;
  await db.tx(async (t) => {
    const target = await groupById(t, ctx.gathering.id, groupId);
    if (target.kind === "private" && !(await isMember(t, target.id, ctx.me.id))) {
      await audit(t, ctx.gathering.id, "enter_denied", ctx.me.id, null, { group: target.id });
      // Same error as non-existent group so private groups can't be probed.
      throw new ApiError(404, "group_not_found", "That conversation is not available");
    }
    outcome = await moveInTx(t, ctx.gathering.id, ctx.me.id, target, ctx.me.id, "enter");
  });
  await applyMoveEffects(ctx.me.id, outcome!, false, groupId);
  return mintMediaToken(ctx);
}

export async function returnToMain(ctx: AuthContext): Promise<MediaTokenView> {
  const db = await getDb();
  const main = await mainGroup(db, ctx.gathering.id);
  return enterGroup(ctx, main.id);
}

export async function createPrivateGroup(
  ctx: AuthContext,
  name: string,
  inviteeIds: string[],
): Promise<{ groupId: string; media: MediaTokenView }> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  const groupId = newId();
  let outcome: MoveOutcome | null = null;
  let inviteeRooms: { room: string; id: string }[] = [];
  await db.tx(async (t) => {
    const open = await t.query(
      "select 1 from groups where gathering_id = $1 and kind = 'private' and closed_at is null",
      [ctx.gathering.id],
    );
    if (open.length >= MAX_PRIVATE_GROUPS) throw new ApiError(409, "too_many_groups", "Too many open conversations");
    await t.query(
      "insert into groups (id, gathering_id, kind, name, livekit_room, created_by) values ($1, $2, 'private', $3, $4, $5)",
      [groupId, ctx.gathering.id, name, newRoomName(), ctx.me.id],
    );
    await t.query("insert into group_members (group_id, participant_id, role) values ($1, $2, 'owner')", [groupId, ctx.me.id]);
    await audit(t, ctx.gathering.id, "group_created", ctx.me.id, null, { group: groupId });
    inviteeRooms = await createInvitationsInTx(t, ctx, groupId, inviteeIds);
    const target = await groupById(t, ctx.gathering.id, groupId);
    outcome = await moveInTx(t, ctx.gathering.id, ctx.me.id, target, ctx.me.id, "create_group");
  });
  await applyMoveEffects(ctx.me.id, outcome!, false, groupId);
  await nudgeEach(inviteeRooms);
  return { groupId, media: await mintMediaToken(ctx) };
}

async function createInvitationsInTx(
  t: Queryable,
  ctx: AuthContext,
  groupId: string,
  inviteeIds: string[],
): Promise<{ room: string; id: string }[]> {
  const unique = [...new Set(inviteeIds)].filter((id) => id !== ctx.me.id).slice(0, 8);
  if (unique.length === 0) return [];
  const valid = await t.query<{ id: string; room: string | null }>(
    `select p.id, gr.livekit_room as room from participants p
       left join groups gr on gr.id = p.active_group_id
      where p.gathering_id = $1 and p.id = any($2::uuid[]) and p.left_at is null and p.kicked_at is null`,
    [ctx.gathering.id, unique],
  );
  if (valid.length !== unique.length) throw new ApiError(400, "invalid_invitee", "Someone you invited is not in this gathering");
  const out: { room: string; id: string }[] = [];
  for (const v of valid) {
    if (await isMember(t, groupId, v.id)) continue;
    const res = await t.query(
      `insert into invitations (id, gathering_id, group_id, from_participant_id, to_participant_id)
       values ($1, $2, $3, $4, $5)
       on conflict (group_id, to_participant_id) where status = 'pending' do nothing
       returning id`,
      [newId(), ctx.gathering.id, groupId, ctx.me.id, v.id],
    );
    if (res.length > 0 && v.room) out.push({ room: v.room, id: v.id });
  }
  await audit(t, ctx.gathering.id, "invitations_sent", ctx.me.id, null, { group: groupId, count: out.length });
  await bumpVersion(t, ctx.gathering.id);
  return out;
}

async function nudgeEach(targets: { room: string; id: string }[]) {
  const admin = getMediaAdmin();
  for (const x of targets) {
    await bestEffort("nudge invitee", () => admin.sendData(x.room, [x.id], { t: "refresh" }, "interp.control"));
  }
}

export async function inviteToGroup(ctx: AuthContext, groupId: string, inviteeIds: string[]): Promise<number> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  let targets: { room: string; id: string }[] = [];
  await db.tx(async (t) => {
    const gr = await groupById(t, ctx.gathering.id, groupId);
    if (gr.kind !== "private") throw new ApiError(400, "not_private", "Everyone can already join the main conversation");
    if (!(await isMember(t, gr.id, ctx.me.id))) throw new ApiError(404, "group_not_found", "That conversation is not available");
    targets = await createInvitationsInTx(t, ctx, gr.id, inviteeIds);
  });
  await nudgeEach(targets);
  return targets.length;
}

export async function respondToInvitation(
  ctx: AuthContext,
  invitationId: string,
  action: "accept" | "decline",
): Promise<MediaTokenView | null> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  let outcome: MoveOutcome | null = null;
  let groupId = "";
  let inviter: { room: string; id: string } | null = null;
  await db.tx(async (t) => {
    const rows = await t.query<{ id: string; group_id: string; status: string; from_participant_id: string }>(
      "select * from invitations where id = $1 and to_participant_id = $2 and gathering_id = $3 for update",
      [invitationId, ctx.me.id, ctx.gathering.id],
    );
    const inv = rows[0];
    if (!inv || inv.status !== "pending") throw new ApiError(404, "invitation_not_found", "That invitation is no longer valid");
    groupId = inv.group_id;
    const gr = await groupById(t, ctx.gathering.id, inv.group_id);
    await t.query("update invitations set status = $2, responded_at = now() where id = $1", [
      inv.id,
      action === "accept" ? "accepted" : "declined",
    ]);
    const inviterRow = (
      await t.query<{ id: string; room: string | null }>(
        "select p.id, g.livekit_room as room from participants p left join groups g on g.id = p.active_group_id where p.id = $1",
        [inv.from_participant_id],
      )
    )[0];
    if (inviterRow?.room) inviter = { room: inviterRow.room, id: inviterRow.id };
    if (action === "accept") {
      await t.query(
        "insert into group_members (group_id, participant_id, role) values ($1, $2, 'member') on conflict do nothing",
        [gr.id, ctx.me.id],
      );
      outcome = await moveInTx(t, ctx.gathering.id, ctx.me.id, gr, ctx.me.id, "accept_invite");
    } else {
      await audit(t, ctx.gathering.id, "invite_declined", ctx.me.id, null, { group: gr.id });
      await bumpVersion(t, ctx.gathering.id);
    }
  });
  if (inviter) await nudgeEach([inviter]);
  if (action === "decline") return null;
  await applyMoveEffects(ctx.me.id, outcome!, false, groupId);
  return mintMediaToken(ctx);
}

export async function removeFromGroup(ctx: AuthContext, groupId: string, participantId: string): Promise<void> {
  const db = await getDb();
  await rateLimit(db, `action:${ctx.me.id}`, 120, 600);
  let outcome: MoveOutcome | null = null;
  let wasActive = false;
  let mainId = "";
  await db.tx(async (t) => {
    const gr = await groupById(t, ctx.gathering.id, groupId);
    if (gr.kind !== "private") throw new ApiError(400, "not_private");
    const owner = await t.query(
      "select 1 from group_members where group_id = $1 and participant_id = $2 and role = 'owner'",
      [gr.id, ctx.me.id],
    );
    if (owner.length === 0) throw new ApiError(403, "not_owner", "Only the person who started this conversation can remove people");
    if (participantId === ctx.me.id) throw new ApiError(400, "use_leave", "Use leave to exit your own conversation");
    const target = (await t.query<ParticipantRow>("select * from participants where id = $1 and gathering_id = $2 for update", [participantId, ctx.gathering.id]))[0];
    if (!target) throw new ApiError(404, "participant_not_found");
    await t.query("delete from group_members where group_id = $1 and participant_id = $2", [gr.id, participantId]);
    await t.query(
      "update invitations set status = 'revoked', responded_at = now() where group_id = $1 and to_participant_id = $2 and status = 'pending'",
      [gr.id, participantId],
    );
    await audit(t, ctx.gathering.id, "member_removed", ctx.me.id, participantId, { group: gr.id });
    wasActive = target.active_group_id === gr.id;
    const main = await mainGroup(t, ctx.gathering.id);
    mainId = main.id;
    if (wasActive) {
      outcome = await moveInTx(t, ctx.gathering.id, participantId, main, ctx.me.id, "removed_by_owner");
    } else {
      await bumpVersion(t, ctx.gathering.id);
    }
  });
  if (outcome) await applyMoveEffects(participantId, outcome, true, mainId);
}

export async function leaveGroup(ctx: AuthContext, groupId: string): Promise<MediaTokenView> {
  const db = await getDb();
  const gr = await groupById(db, ctx.gathering.id, groupId);
  if (gr.kind === "main") throw new ApiError(400, "cannot_leave_main", "Join another conversation instead");
  if (ctx.me.active_group_id === gr.id) return returnToMain(ctx);
  // Not currently in it: just drop membership.
  await db.tx(async (t) => {
    await t.query("delete from group_members where group_id = $1 and participant_id = $2", [gr.id, ctx.me.id]);
    const left = await t.query("select 1 from group_members where group_id = $1", [gr.id]);
    if (left.length === 0) await t.query("update groups set closed_at = now() where id = $1", [gr.id]);
    await bumpVersion(t, ctx.gathering.id);
  });
  return mintMediaToken(ctx);
}

export async function renameGroup(ctx: AuthContext, groupId: string, name: string): Promise<void> {
  const db = await getDb();
  await db.tx(async (t) => {
    const gr = await groupById(t, ctx.gathering.id, groupId);
    if (gr.kind !== "private" || !(await isMember(t, gr.id, ctx.me.id))) {
      throw new ApiError(404, "group_not_found", "That conversation is not available");
    }
    await t.query("update groups set name = $2 where id = $1", [gr.id, name]);
    await bumpVersion(t, ctx.gathering.id);
  });
}

// --------------------------------------------------------- host controls

function requireHost(ctx: AuthContext) {
  if (ctx.me.role !== "host" || ctx.gathering.host_participant_id !== ctx.me.id) {
    throw new ApiError(403, "not_host", "Only the host can do that");
  }
}

export async function kickParticipant(ctx: AuthContext, participantId: string): Promise<void> {
  requireHost(ctx);
  if (participantId === ctx.me.id) throw new ApiError(400, "cannot_kick_self");
  await removeParticipantFromGathering(ctx.gathering.id, participantId, ctx.me.id, "kicked");
}

export async function leaveGathering(ctx: AuthContext): Promise<void> {
  if (ctx.me.role === "host") {
    throw new ApiError(400, "host_must_end", "As host, end the gathering instead (or hand off by ending and recreating)");
  }
  await removeParticipantFromGathering(ctx.gathering.id, ctx.me.id, ctx.me.id, "left");
}

async function removeParticipantFromGathering(
  gatheringId: string,
  participantId: string,
  actorId: string,
  how: "kicked" | "left",
): Promise<void> {
  const db = await getDb();
  let room: string | null = null;
  let stayed: string[] = [];
  const closedRooms: string[] = [];
  await db.tx(async (t) => {
    const p = (await t.query<ParticipantRow>("select * from participants where id = $1 and gathering_id = $2 for update", [participantId, gatheringId]))[0];
    if (!p || p.left_at || p.kicked_at) throw new ApiError(404, "participant_not_found");
    if (p.active_group_id) {
      const gr = (await t.query<GroupRow>("select * from groups where id = $1", [p.active_group_id]))[0];
      room = gr?.livekit_room ?? null;
      stayed = (
        await t.query<{ id: string }>(
          "select id from participants where active_group_id = $1 and id <> $2 and left_at is null and kicked_at is null",
          [p.active_group_id, p.id],
        )
      ).map((r) => r.id);
    }
    const groupsOf = await t.query<{ group_id: string }>("select group_id from group_members where participant_id = $1", [p.id]);
    await t.query("delete from group_members where participant_id = $1", [p.id]);
    for (const { group_id } of groupsOf) {
      const left = await t.query("select 1 from group_members where group_id = $1", [group_id]);
      if (left.length === 0) {
        const closed = await t.query<{ livekit_room: string }>(
          "update groups set closed_at = now() where id = $1 and kind = 'private' returning livekit_room",
          [group_id],
        );
        if (closed[0]) {
          closedRooms.push(closed[0].livekit_room);
          await t.query(
            "update invitations set status = 'revoked', responded_at = now() where group_id = $1 and status = 'pending'",
            [group_id],
          );
        }
      }
    }
    await t.query(
      `update invitations set status = 'revoked', responded_at = now()
        where (to_participant_id = $1 or from_participant_id = $1) and status = 'pending'`,
      [p.id],
    );
    await t.query(
      `update participants set ${how === "kicked" ? "kicked_at" : "left_at"} = now(),
         active_group_id = null, active_epoch = active_epoch + 1 where id = $1`,
      [p.id],
    );
    await audit(t, gatheringId, how === "kicked" ? "participant_kicked" : "participant_left", actorId, p.id);
    await bumpVersion(t, gatheringId);
  });
  const admin = getMediaAdmin();
  if (room) {
    await bestEffort("evict", () => admin.removeParticipant(room!, participantId));
    await bestEffort("nudge", () => admin.sendData(room!, stayed, { t: "refresh" }, "interp.control"));
  }
  for (const r of closedRooms) await bestEffort("delete room", () => admin.deleteRoom(r));
}

export async function muteParticipant(ctx: AuthContext, participantId: string): Promise<boolean> {
  requireHost(ctx);
  const db = await getDb();
  const rows = await db.query<{ active_group_id: string | null }>(
    "select active_group_id from participants where id = $1 and gathering_id = $2 and left_at is null and kicked_at is null",
    [participantId, ctx.gathering.id],
  );
  const target = rows[0];
  // The host may only act on people in their own current conversation:
  // hosting does not grant access to private groups.
  if (!target || !target.active_group_id || target.active_group_id !== ctx.me.active_group_id) {
    throw new ApiError(404, "participant_not_here", "That person is not in your conversation");
  }
  const gr = await groupById(db, ctx.gathering.id, target.active_group_id);
  const ok = await getMediaAdmin().muteMicrophone(gr.livekit_room, participantId);
  await audit(db, ctx.gathering.id, "participant_muted", ctx.me.id, participantId, { ok });
  return ok;
}

export async function rotateInvite(ctx: AuthContext): Promise<string> {
  requireHost(ctx);
  const db = await getDb();
  const rows = await db.query<GatheringRow>(
    "update gatherings set invite_version = invite_version + 1, version = version + 1 where id = $1 returning *",
    [ctx.gathering.id],
  );
  await audit(db, ctx.gathering.id, "invite_rotated", ctx.me.id, null);
  return inviteUrlPath(ctx.gathering.id, await inviteTokenFor(db, rows[0]));
}

export async function endGathering(ctx: AuthContext): Promise<void> {
  requireHost(ctx);
  await endGatheringInternal(ctx.gathering.id, "ended_by_host", ctx.me.id);
}

/**
 * End a gathering and delete its personal data (names, memberships,
 * invitations). Anonymous usage records remain for the spending meters.
 */
export async function endGatheringInternal(gatheringId: string, reason: string, actorId: string | null): Promise<void> {
  const db = await getDb();
  const rooms = await db.query<{ livekit_room: string }>("select livekit_room from groups where gathering_id = $1", [gatheringId]);
  const people = await db.query<{ id: string; room: string | null }>(
    `select p.id, g.livekit_room as room from participants p left join groups g on g.id = p.active_group_id
      where p.gathering_id = $1 and p.left_at is null and p.kicked_at is null`,
    [gatheringId],
  );
  const admin = getMediaAdmin();
  const byRoom = new Map<string, string[]>();
  for (const p of people) if (p.room) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p.id]);
  for (const [room, ids] of byRoom) {
    await bestEffort("nudge ended", () => admin.sendData(room, ids, { t: "ended" }, "interp.control"));
  }
  await db.tx(async (t) => {
    await audit(t, gatheringId, "gathering_ended", actorId, null, { reason });
    await t.query("delete from gatherings where id = $1", [gatheringId]);
  });
  // Deleting the rooms disconnects everyone, including the translator agent,
  // which closes every provider session for those rooms.
  for (const { livekit_room } of rooms) {
    await bestEffort("delete room", () => admin.deleteRoom(livekit_room));
  }
}

// -------------------------------------------------- worker-facing (internal)

export interface AdmissionResult {
  gatheringId: string;
  groupId: string;
  participants: Record<string, { allowed: boolean; epoch: number | null; reason: string | null }>;
  translation: { allowed: boolean; reason: string | null; defaultProvider: string };
}

export async function admission(room: string, identities: string[]): Promise<AdmissionResult | null> {
  const db = await getDb();
  const rows = await db.query<GroupRow & { g: Record<string, unknown> }>(
    `select gr.*, row_to_json(ga.*) as g from groups gr join gatherings ga on ga.id = gr.gathering_id
      where gr.livekit_room = $1`,
    [room],
  );
  const row = rows[0];
  if (!row) return null;
  const { g: graw, ...gr } = row;
  const g = normaliseGathering(graw);
  const ids = [...new Set(identities)].slice(0, 32);
  const ps = ids.length
    ? await db.query<ParticipantRow>("select * from participants where gathering_id = $1 and id::text = any($2::text[])", [
        g.id,
        ids,
      ])
    : [];
  const byId = new Map(ps.map((p) => [p.id, p]));
  const memberRows =
    gr.kind === "private"
      ? await db.query<{ participant_id: string }>("select participant_id from group_members where group_id = $1", [gr.id])
      : [];
  const members = new Set(memberRows.map((m) => m.participant_id));

  const result: AdmissionResult["participants"] = {};
  const ended = Boolean(g.ended_at) || Boolean(gr.closed_at);
  for (const id of ids) {
    const p = byId.get(id);
    let reason: string | null = null;
    if (!p) reason = "unknown";
    else if (ended) reason = "gathering_ended";
    else if (p.kicked_at) reason = "kicked";
    else if (p.left_at) reason = "left";
    else if (p.active_group_id !== gr.id) reason = "not_in_group";
    else if (gr.kind === "private" && !members.has(p.id)) reason = "not_in_group";
    result[id] = { allowed: reason === null, epoch: p && reason === null ? p.active_epoch : null, reason };
  }
  const denied = Object.entries(result).filter(([, v]) => !v.allowed);
  if (denied.length > 0) {
    await audit(db, g.id, "admission_denied", null, null, {
      group: gr.id,
      count: denied.length,
      reasons: [...new Set(denied.map(([, v]) => v.reason))],
    });
  }
  const budget = await budgetFor(db, g);
  return {
    gatheringId: g.id,
    groupId: gr.id,
    participants: result,
    translation: { allowed: budget.translationAllowed && !ended, reason: ended ? "gathering_ended" : budget.reason, defaultProvider: g.default_provider },
  };
}

export interface UsageRecordInput {
  speakerId: string;
  targetLang: string;
  provider: string;
  inputSeconds: number;
  outputSeconds: number;
  sessionSeconds: number;
  periodStart?: string;
  periodEnd?: string;
  errors?: number;
  firstAudioMs?: number[];
}

const PROVIDERS = new Set(["gemini", "openai", "mock"]);

function boundedSeconds(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 3600);
}

export async function recordUsage(room: string, records: UsageRecordInput[]) {
  const db = await getDb();
  const rows = await db.query<GroupRow & { g: Record<string, unknown> }>(
    `select gr.*, row_to_json(ga.*) as g from groups gr join gatherings ga on ga.id = gr.gathering_id
      where gr.livekit_room = $1`,
    [room],
  );
  const row = rows[0];
  if (!row) {
    // Gathering already deleted: tell the worker to stop.
    return {
      translation: { allowed: false, reason: "gathering_ended" },
      spend: null,
    };
  }
  const { g: graw, ...gr } = row;
  let total = 0;
  await db.tx(async (t) => {
    for (const r of records.slice(0, 64)) {
      const provider = PROVIDERS.has(r.provider) ? r.provider : "unknown";
      const usage = {
        provider,
        inputSeconds: boundedSeconds(r.inputSeconds),
        outputSeconds: boundedSeconds(r.outputSeconds),
        sessionSeconds: boundedSeconds(r.sessionSeconds),
      };
      const cost = estimateCostUsd(usage);
      total += cost;
      const samples = Array.isArray(r.firstAudioMs)
        ? r.firstAudioMs.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n < 120_000).slice(0, 100).map(Math.round)
        : [];
      await t.query(
        `insert into usage_records
           (gathering_id, group_id, speaker_id, target_lang, provider, input_seconds, output_seconds,
            session_seconds, cost_usd, errors, first_audio_ms, period_start, period_end)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::int[], $12, $13)`,
        [
          gr.gathering_id,
          gr.id,
          typeof r.speakerId === "string" && /^[0-9a-f-]{36}$/i.test(r.speakerId) ? r.speakerId : null,
          String(r.targetLang).slice(0, 8),
          provider,
          usage.inputSeconds,
          usage.outputSeconds,
          usage.sessionSeconds,
          cost,
          Math.max(0, Math.min(10_000, Number(r.errors ?? 0) || 0)),
          samples,
          r.periodStart ? new Date(r.periodStart) : null,
          r.periodEnd ? new Date(r.periodEnd) : null,
        ],
      );
    }
    await t.query("update gatherings set spent_usd = spent_usd + $2, last_activity_at = now() where id = $1", [
      gr.gathering_id,
      total,
    ]);
  });
  const g = normaliseGathering({ ...graw, spent_usd: Number(graw.spent_usd) + total });
  const budget = await budgetFor(db, g);
  return {
    translation: { allowed: budget.translationAllowed && !gr.closed_at, reason: gr.closed_at ? "gathering_ended" : budget.reason },
    spend: {
      gatheringUsd: budget.gatheringUsd,
      monthUsd: budget.monthUsd,
      dayUsd: budget.dayUsd,
      capGatheringUsd: budget.gatheringCapUsd,
      capMonthUsd: budget.monthCapUsd,
      capDayUsd: budget.dayCapUsd,
    },
  };
}

// ------------------------------------------------------------ maintenance

export async function cleanupExpiredGatherings(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `select id from gatherings
      where expires_at < now()
         or last_activity_at < now() - ($1 || ' minutes')::interval`,
    [String(config.idleEndMinutes)],
  );
  for (const r of rows) await endGatheringInternal(r.id, "cleanup", null);
  await db.query("delete from audit_events where created_at < now() - interval '30 days'");
  await db.query("delete from rate_limits where window_start < now() - interval '1 day'");
  return rows.length;
}

/** Aggregated, content-free usage report for the host dashboard. */
export async function usageReport(q: Queryable, gatheringId: string) {
  // Sums and latency samples are aggregated separately: unnesting samples in
  // the same query would multiply every duration by the sample count.
  const rows = await q.query<{
    provider: string;
    target_lang: string;
    input_seconds: number;
    output_seconds: number;
    cost_usd: number;
    samples: number[] | null;
  }>(
    `with sums as (
       select provider, target_lang, sum(input_seconds) as input_seconds,
              sum(output_seconds) as output_seconds, sum(cost_usd) as cost_usd
         from usage_records where gathering_id = $1 group by provider, target_lang
     ), lat as (
       select u.provider, u.target_lang, array_agg(s) as samples
         from usage_records u cross join lateral unnest(u.first_audio_ms) s
        where u.gathering_id = $1 group by u.provider, u.target_lang
     )
     select sums.*, lat.samples from sums
       left join lat on lat.provider = sums.provider and lat.target_lang = sums.target_lang`,
    [gatheringId],
  );
  return rows.map((r) => {
    const samples = (r.samples ?? []).map(Number).sort((a, b) => a - b);
    const pct = (p: number) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] : null);
    return {
      provider: r.provider,
      targetLang: r.target_lang,
      inputMinutes: Number(r.input_seconds) / 60,
      outputMinutes: Number(r.output_seconds) / 60,
      costUsd: Number(r.cost_usd),
      firstAudioP50Ms: pct(0.5),
      firstAudioP95Ms: pct(0.95),
      samples: samples.length,
    };
  });
}

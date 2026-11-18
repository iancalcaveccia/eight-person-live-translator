/**
 * Content-free interpreter diagnostics (worker_events): written by the worker
 * over the signed internal API, read back over the same signed API for
 * reviews. Never stores names, transcript words or audio — only numbers,
 * language codes and short machine labels, validated here.
 */
import "server-only";
import { getDb } from "./db";
import { ApiError, isUuid } from "./http";

export const EVENT_KINDS = new Set([
  "session_started",
  "session_closed",
  "minute",
  "rotation",
  "stall",
  "stream_error",
  "crosstalk_hold",
  "crosstalk_lift",
  "crosstalk_summary",
  "bleed_summary",
  "worker_started",
]);

const MAX_EVENTS_PER_CALL = 300;
const MAX_STRING = 64;
const ROOM_RE = /^grp_[a-z2-7]{24}$/;

export interface WorkerEventInput {
  ts?: unknown;
  kind?: unknown;
  speaker?: unknown;
  target?: unknown;
  data?: unknown;
}

/** Keep numbers, booleans, short machine strings, and one level of {label: number}. */
export function cleanEventData(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) continue;
    if (typeof val === "number") {
      if (Number.isFinite(val)) out[k] = Math.round(val * 1000) / 1000;
    } else if (typeof val === "boolean") {
      out[k] = val;
    } else if (typeof val === "string") {
      // Machine labels only (reasons, codes, language tags, short ids): no
      // spaces, so not even a short sentence can be stored.
      if (/^[a-zA-Z0-9_.:\->]{0,64}$/.test(val)) out[k] = val.slice(0, MAX_STRING);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      const inner: Record<string, number> = {};
      for (const [ik, iv] of Object.entries(val as Record<string, unknown>).slice(0, 20)) {
        if (/^[a-zA-Z0-9_-]{1,16}$/.test(ik) && typeof iv === "number" && Number.isFinite(iv)) inner[ik] = iv;
      }
      out[k] = inner;
    } else if (Array.isArray(val)) {
      const nums = val.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(0, 50);
      if (nums.length === val.length) out[k] = nums;
    }
  }
  return out;
}

export async function recordWorkerEvents(room: string, events: WorkerEventInput[]): Promise<number> {
  if (!ROOM_RE.test(room)) throw new ApiError(400, "invalid_room");
  const db = await getDb();
  const grp = (
    await db.query<{ id: string; gathering_id: string }>("select id, gathering_id from groups where livekit_room = $1", [room])
  )[0];
  const now = Date.now();
  let stored = 0;
  for (const e of events.slice(0, MAX_EVENTS_PER_CALL)) {
    if (typeof e.kind !== "string" || !EVENT_KINDS.has(e.kind)) continue;
    const tsMs = typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts * 1000 : now;
    const when = new Date(Math.min(now + 60_000, Math.max(now - 86_400_000, tsMs)));
    await db.query(
      `insert into worker_events (created_at, room, gathering_id, group_id, kind, speaker_id, target_lang, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)`,
      [
        when,
        room,
        grp?.gathering_id ?? null,
        grp?.id ?? null,
        e.kind,
        isUuid(e.speaker) ? e.speaker : null,
        typeof e.target === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(e.target) ? e.target : null,
        JSON.stringify(cleanEventData(e.data)),
      ],
    );
    stored++;
  }
  return stored;
}

/**
 * Rows written before the `$n::text::jsonb` fix hold their data twice encoded
 * (a JSON string inside jsonb): postgres.js serialises a jsonb parameter with
 * JSON.stringify even when it is already a string. Read both forms.
 */
function storedObject(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

export interface DiagnosticsQuery {
  since?: unknown;
  until?: unknown;
  room?: unknown;
}

/** Events and anonymous usage rows for a period (default: last 24 h). */
export async function readDiagnostics(q: DiagnosticsQuery) {
  const now = Date.now();
  const since = typeof q.since === "string" && !Number.isNaN(Date.parse(q.since)) ? new Date(q.since) : new Date(now - 86_400_000);
  const until = typeof q.until === "string" && !Number.isNaN(Date.parse(q.until)) ? new Date(q.until) : new Date(now + 60_000);
  const room = typeof q.room === "string" && ROOM_RE.test(q.room) ? q.room : null;
  const db = await getDb();
  const events = (
    await db.query<{ data: unknown }>(
      `select created_at, room, kind, speaker_id, target_lang, data from worker_events
        where created_at >= $1 and created_at <= $2 and ($3::text is null or room = $3)
        order by created_at asc limit 20000`,
      [since, until, room],
    )
  ).map((e) => ({ ...e, data: storedObject(e.data) }));
  const usage = await db.query(
    `select created_at, gathering_id, group_id, speaker_id, target_lang, provider, input_seconds, output_seconds,
            session_seconds, cost_usd, errors, first_audio_ms, period_start, period_end
       from usage_records where created_at >= $1 and created_at <= $2
      order by created_at asc limit 20000`,
    [since, until],
  );
  return { since: since.toISOString(), until: until.toISOString(), events, usage };
}

export async function pruneWorkerEvents(): Promise<void> {
  const db = await getDb();
  await db.query("delete from worker_events where created_at < now() - interval '30 days'");
}

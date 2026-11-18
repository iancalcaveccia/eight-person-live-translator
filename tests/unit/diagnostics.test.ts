/**
 * Content-free worker diagnostics: signed write, signed read, validation that
 * keeps words out, 30-day retention.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { POST as eventsRoute } from "@/app/api/internal/events/route";
import { POST as diagnosticsRoute } from "@/app/api/internal/diagnostics/route";
import { POST as createGatheringRoute } from "@/app/api/gatherings/route";
import { POST as tokenRoute } from "@/app/api/gatherings/[gid]/token/route";
import { Client, freshEnvironment, signedRequest } from "./helpers";
import type { Db } from "@/server/db";
import { cleanupExpiredGatherings } from "@/server/gatherings";
import { cleanEventData } from "@/server/diagnostics";

let db: Db;
const SPEAKER = "11111111-1111-4111-8111-111111111111";

beforeEach(async () => {
  ({ db } = await freshEnvironment({ OPEN_GATHERING_CREATION: "1" }));
});

async function liveRoom(): Promise<string> {
  const host = new Client("198.51.100.7");
  const created = await host.call(createGatheringRoute, {
    body: { title: "Diag", displayName: "Ian", consent: true, speakLang: "es", listenLang: "es", esRegion: "" },
  });
  const media = await host.call(tokenRoute, { params: { gid: created.body.gatheringId as string } });
  return media.body.room as string;
}

describe("worker diagnostics", () => {
  it("stores signed events with their room and gathering, and reads them back signed", async () => {
    const room = await liveRoom();
    const res = await eventsRoute(
      signedRequest({
        room,
        events: [
          { ts: Date.now() / 1000, kind: "session_started", speaker: SPEAKER, target: "pl", data: { provider: "gemini", echo: false } },
          { kind: "minute", speaker: SPEAKER, target: "pl", data: { output_s: 41.2, first_audio_p50_ms: 3120, heard: { es: 12, pl: 2 } } },
          { kind: "not_a_kind", data: {} },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 2 });
    const rows = await db.query<{ gathering_id: string | null; kind: string }>("select gathering_id, kind from worker_events order by id");
    expect(rows.map((r) => r.kind)).toEqual(["session_started", "minute"]);
    expect(rows[0].gathering_id).not.toBeNull();

    const read = await diagnosticsRoute(signedRequest({ room }));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { events: { kind: string; data: Record<string, unknown> }[] };
    expect(body.events).toHaveLength(2);
    expect(body.events[1].data).toEqual({ output_s: 41.2, first_audio_p50_ms: 3120, heard: { es: 12, pl: 2 } });
  });

  it("stores the data as a JSON object, and still reads rows that an older version stored as a JSON string", async () => {
    const room = "grp_abcdefghijklmnopqrstuvwx";
    await eventsRoute(signedRequest({ room, events: [{ kind: "minute", data: { output_s: 7 } }] }));
    const types = await db.query<{ t: string }>("select jsonb_typeof(data) as t from worker_events");
    expect(types).toEqual([{ t: "object" }]);
    // What postgres.js wrote before the fix: the JSON text itself, as a jsonb string.
    await db.query("insert into worker_events (room, kind, data) values ($1, 'minute', to_jsonb($2::text))", [
      room,
      JSON.stringify({ output_s: 5, heard: { es: 4 } }),
    ]);
    const read = await diagnosticsRoute(signedRequest({ room }));
    const body = (await read.json()) as { events: { data: unknown }[] };
    expect(body.events.map((e) => e.data)).toEqual([{ output_s: 7 }, { output_s: 5, heard: { es: 4 } }]);
  });

  it("keeps events of a room whose gathering already ended (closing summaries arrive late)", async () => {
    const res = await eventsRoute(signedRequest({ room: "grp_abcdefghijklmnopqrstuvwx", events: [{ kind: "session_closed", data: { reason: "speaker_left" } }] }));
    expect(res.status).toBe(200);
    const rows = await db.query<{ room: string; gathering_id: string | null }>("select room, gathering_id from worker_events");
    expect(rows).toEqual([{ room: "grp_abcdefghijklmnopqrstuvwx", gathering_id: null }]);
  });

  it("rejects unsigned or wrongly signed calls, for writing and for reading", async () => {
    const unsigned = new Request("http://app.test/api/internal/events", { method: "POST", body: JSON.stringify({ room: "x", events: [] }) });
    expect((await eventsRoute(unsigned)).status).toBe(401);
    expect((await diagnosticsRoute(signedRequest({}, "wrong-secret"))).status).toBe(401);
  });

  it("never stores free text: sentences, long strings and nested content are dropped", () => {
    const cleaned = cleanEventData({
      reason: "grace_expired",
      text: "Mañana vamos a comer empanadas en la casa de mi madre",
      english: "we will eat at home tomorrow",
      message: "x".repeat(200),
      heard: { es: 3, "this is not a label": 1, pl: "many" },
      words: ["hola", "chau"],
      levels: [-36.2, -14.9],
      nested: { deep: { deeper: 1 } },
    });
    expect(cleaned).toEqual({ reason: "grace_expired", heard: { es: 3 }, levels: [-36.2, -14.9], nested: {} });
  });

  it("forgets diagnostics after 30 days", async () => {
    await eventsRoute(signedRequest({ room: "grp_abcdefghijklmnopqrstuvwx", events: [{ kind: "minute", data: {} }] }));
    await db.query("update worker_events set created_at = now() - interval '31 days'");
    await cleanupExpiredGatherings();
    expect((await db.query("select 1 from worker_events")).length).toBe(0);
  });
});

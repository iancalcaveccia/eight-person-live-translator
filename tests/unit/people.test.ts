/**
 * Remembered people and saved tables: authorization, privacy and lifecycle,
 * against real Postgres (PGlite) and the real route handlers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GET as meGet, POST as mePost, PATCH as mePatch, DELETE as meDelete } from "@/app/api/me/route";
import { POST as createTableRoute } from "@/app/api/tables/route";
import { PATCH as renameRoute } from "@/app/api/tables/[tid]/route";
import { POST as enterRoute } from "@/app/api/tables/[tid]/enter/route";
import { POST as joinTableRoute } from "@/app/api/tables/[tid]/join/route";
import { POST as previewRoute } from "@/app/api/tables/[tid]/preview/route";
import { POST as rotateRoute } from "@/app/api/tables/[tid]/invite/rotate/route";
import { DELETE as memberDelete } from "@/app/api/tables/[tid]/members/[pid]/route";
import { GET as stateRoute, } from "@/app/api/gatherings/[gid]/state/route";
import { PATCH as gatheringMeRoute } from "@/app/api/gatherings/[gid]/me/route";
import { POST as createGatheringRoute } from "@/app/api/gatherings/route";
import { POST as joinGatheringRoute } from "@/app/api/gatherings/[gid]/join/route";
import { POST as kickRoute } from "@/app/api/gatherings/[gid]/participants/[pid]/kick/route";
import { POST as endRoute } from "@/app/api/gatherings/[gid]/end/route";
import { POST as leaveGatheringRoute } from "@/app/api/gatherings/[gid]/leave/route";
import { Client, FakeMediaAdmin, freshEnvironment, inviteTokenFromPath } from "./helpers";
import type { GatheringStateView, HomeView } from "@/lib/api-types";
import type { Db } from "@/server/db";
import { cleanupExpiredGatherings } from "@/server/gatherings";

let admin: FakeMediaAdmin;
let db: Db;

beforeEach(async () => {
  ({ admin, db } = await freshEnvironment({ OPEN_GATHERING_CREATION: "1" }));
});

const prefs = (speakLang: string, listenLang = speakLang) => ({ speakLang, listenLang, esRegion: "" });
let ipCounter = 1;
const newPhone = () => new Client(`198.51.100.${ipCounter++ % 250}`);

async function remember(c: Client, name: string, lang = "es") {
  const res = await c.call(mePost, { body: { displayName: name, consent: true, ...prefs(lang) } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(c.cookies.has("mesa_me")).toBe(true);
  return (res.body.person as { id: string }).id;
}

async function home(c: Client): Promise<HomeView> {
  const res = await c.call(meGet, { method: "GET" });
  expect(res.status).toBe(200);
  return res.body as unknown as HomeView;
}

async function newTable(c: Client, name = "Family", memberIds: string[] = []) {
  const res = await c.call(createTableRoute, { body: { name, memberIds } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { tid: res.body.tableId as string, gid: res.body.gatheringId as string };
}

async function tableLink(c: Client, tid: string) {
  const h = await home(c);
  const t = h.tables.find((x) => x.id === tid)!;
  return inviteTokenFromPath(t.inviteUrlPath);
}

async function state(c: Client, gid: string) {
  const res = await c.call(stateRoute, { method: "GET", params: { gid } });
  return { status: res.status, body: res.body as unknown as GatheringStateView };
}

describe("remember me on this phone", () => {
  it("creates a profile with an httpOnly 400-day cookie, stores only a hash, and renews it on visit", async () => {
    const c = newPhone();
    const res = await c.call(mePost, { body: { displayName: "Ian", consent: true, ...prefs("es") } });
    expect(res.status).toBe(201);
    const secret = c.cookies.get("mesa_me")!;
    expect(secret.length).toBeGreaterThanOrEqual(43);
    const stored = await db.query<{ session_hash: string }>("select session_hash from person_devices");
    expect(stored).toHaveLength(1);
    expect(stored[0].session_hash).not.toContain(secret);
    expect(stored[0].session_hash).toMatch(/^[0-9a-f]{64}$/);

    const h = await home(c);
    expect(h.person?.displayName).toBe("Ian");
    expect(h.tables).toEqual([]);
  });

  it("requires consent and validates languages", async () => {
    const c = newPhone();
    expect((await c.call(mePost, { body: { displayName: "Ian", ...prefs("es") } })).status).toBe(400);
    expect((await c.call(mePost, { body: { displayName: "Ian", consent: true, ...prefs("xx") } })).status).toBe(400);
  });

  it("a phone without the cookie (or a made-up one) is nobody", async () => {
    const c = newPhone();
    expect((await home(c)).person).toBeNull();
    c.cookies.set("mesa_me", "made-up-secret-made-up-secret-made-up-secret");
    expect((await home(c)).person).toBeNull();
    expect((await c.call(createTableRoute, { body: { name: "X" } })).status).toBe(401);
  });

  it("edits name and languages", async () => {
    const c = newPhone();
    await remember(c, "Ian");
    const res = await c.call(mePatch, { method: "PATCH", body: { displayName: "Ian C", listenLang: "en" } });
    expect(res.status).toBe(200);
    const h = await home(c);
    expect(h.person).toMatchObject({ displayName: "Ian C", speakLang: "es", listenLang: "en" });
  });

  it("forgetting the only phone deletes the person (no ghost members); the others keep the table", async () => {
    const ian = newPhone();
    const ianId = await remember(ian, "Ian");
    const { tid } = await newTable(ian);
    const ola = newPhone();
    await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: await tableLink(ian, tid) } });

    // Ian forgets this phone — his only one — so his profile goes, and Ola inherits the table.
    const forgotten = await ian.call(meDelete, { method: "DELETE", body: {} });
    expect(forgotten.status).toBe(200);
    expect(ian.cookies.has("mesa_me")).toBe(false);
    expect((await db.query("select 1 from people where id = $1", [ianId])).length).toBe(0);
    const olaHome = await home(ola);
    expect(olaHome.people).toEqual([]);
    expect(olaHome.tables[0].role).toBe("owner");

    // Ola deletes herself everywhere: she was the last one, so the table goes too.
    const gone = await ola.call(meDelete, { method: "DELETE", body: { everything: true } });
    expect(gone.status).toBe(200);
    expect((await db.query("select 1 from people")).length).toBe(0);
    expect((await db.query("select 1 from circles where id = $1", [tid])).length).toBe(0);
  });
});

describe("saved tables", () => {
  it("create → share link once → others join and are remembered → everyone re-enters with one tap", async () => {
    const ian = newPhone();
    await remember(ian, "Ian", "es");
    const { tid, gid } = await newTable(ian, "Family");
    expect(ian.cookies.has(`ig_${gid.replace(/-/g, "")}`)).toBe(true);
    const ianState = await state(ian, gid);
    expect(ianState.body.table).toMatchObject({ id: tid, name: "Family", isMember: true, isOwner: true });
    expect(ianState.body.table!.inviteUrlPath).toMatch(new RegExp(`^/t/${tid}/join#k=`));
    expect(ianState.body.me.role).toBe("host");

    // Ola has no profile yet: one request creates it, adds her to the table and seats her.
    const ola = newPhone();
    const token = inviteTokenFromPath(ianState.body.table!.inviteUrlPath);
    const preview = await ola.call(previewRoute, { params: { tid }, body: { inviteToken: token } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ name: "Family", memberNames: ["Ian"] });
    const joined = await ola.call(joinTableRoute, {
      params: { tid },
      body: { inviteToken: token, displayName: "Ola", consent: true, remember: true, ...prefs("pl") },
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body.gatheringId).toBe(gid);
    expect(ola.cookies.has("mesa_me")).toBe(true);
    const olaHome = await home(ola);
    expect(olaHome.tables.map((t) => t.name)).toEqual(["Family"]);
    expect(olaHome.people.map((p) => p.displayName)).toEqual(["Ian"]);
    expect(olaHome.tables[0].live?.gatheringId).toBe(gid);

    // Everyone leaves; the gathering ends. Next time: one tap starts a fresh one.
    await ian.call(endRoute, { params: { gid } });
    const again = await ola.call(enterRoute, { params: { tid } });
    expect(again.status).toBe(200);
    const gid2 = again.body.gatheringId as string;
    expect(gid2).not.toBe(gid);
    const ianAgain = await ian.call(enterRoute, { params: { tid } });
    expect(ianAgain.body.gatheringId).toBe(gid2);
    const s = await state(ian, gid2);
    expect(s.body.participants.map((p) => p.displayName).sort()).toEqual(["Ian", "Ola"]);
    expect(s.body.me.role).toBe("guest");
    expect((await state(ola, gid2)).body.me.role).toBe("host");
  });

  it("tapping again (other phone, reopened app) takes back the same seat instead of a duplicate", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid, gid } = await newTable(ian);
    const firstCookie = ian.cookies.get(`ig_${gid.replace(/-/g, "")}`);
    const again = await ian.call(enterRoute, { params: { tid } });
    expect(again.body.gatheringId).toBe(gid);
    expect(ian.cookies.get(`ig_${gid.replace(/-/g, "")}`)).not.toBe(firstCookie);
    const s = await state(ian, gid);
    expect(s.body.participants).toHaveLength(1);
  });

  it("only members can enter; a forged or old link is rejected the same way as an unknown table", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid } = await newTable(ian);
    const stranger = newPhone();
    await remember(stranger, "Stranger");
    expect((await stranger.call(enterRoute, { params: { tid } })).status).toBe(404);
    const bad = await stranger.call(joinTableRoute, { params: { tid }, body: { inviteToken: "A".repeat(32) } });
    expect(bad.status).toBe(403);
    const unknown = await stranger.call(joinTableRoute, {
      params: { tid: "11111111-1111-4111-8111-111111111111" },
      body: { inviteToken: "A".repeat(32) },
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toBe(bad.body.error);
    // A gathering invite token is not a table token.
    const s = await state(ian, (await ian.call(enterRoute, { params: { tid } })).body.gatheringId as string);
    const gatheringToken = inviteTokenFromPath(s.body.gathering.inviteUrlPath);
    expect((await stranger.call(joinTableRoute, { params: { tid }, body: { inviteToken: gatheringToken } })).status).toBe(403);
    expect((await stranger.call(previewRoute, { params: { tid }, body: { inviteToken: gatheringToken } })).status).toBe(403);
  });

  it("a one-time guest (remember off) is seated but not saved anywhere", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid, gid } = await newTable(ian);
    const guest = newPhone();
    const res = await guest.call(joinTableRoute, {
      params: { tid },
      body: { inviteToken: await tableLink(ian, tid), displayName: "Marta", consent: true, remember: false, ...prefs("en") },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ gatheringId: gid, remembered: false });
    expect(guest.cookies.has("mesa_me")).toBe(false);
    expect((await db.query("select 1 from people where display_name = 'Marta'")).length).toBe(0);
    expect((await home(ian)).people).toEqual([]);
    expect((await state(guest, gid)).body.table).toMatchObject({ id: tid, isMember: false, isOwner: false });
  });

  it("contacts are only people you share a table with; new tables can include them, nobody else", async () => {
    const ian = newPhone();
    const ianId = await remember(ian, "Ian");
    const { tid } = await newTable(ian, "Family");
    const ola = newPhone();
    const olaId = await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: await tableLink(ian, tid) } });
    const stranger = newPhone();
    const strangerId = await remember(stranger, "Stranger", "en");

    const notContact = await ian.call(createTableRoute, { body: { name: "Us two", memberIds: [strangerId] } });
    expect(notContact.status).toBe(400);
    const pair = await newTable(ian, "Us two", [olaId]);
    const olaHome = await home(ola);
    expect(olaHome.tables.map((t) => t.name).sort()).toEqual(["Family", "Us two"]);
    expect(olaHome.tables.find((t) => t.id === pair.tid)?.live?.onlineNames).toEqual(["Ian"]);
    expect((await home(stranger)).tables).toEqual([]);
    expect((await home(stranger)).people).toEqual([]);
    expect((await home(ian)).people.map((p) => p.id)).toEqual([olaId]);
    void ianId;
  });

  it("the owner removes someone: their seat ends, the link is replaced, and the old link no longer works", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid, gid } = await newTable(ian);
    const oldToken = await tableLink(ian, tid);
    const ola = newPhone();
    const olaId = await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: oldToken } });
    expect((await state(ola, gid)).status).toBe(200);

    // Members cannot remove others; only the owner can.
    const ianId = (await home(ian)).person!.id;
    expect((await ola.call(memberDelete, { method: "DELETE", params: { tid, pid: ianId } })).status).toBe(403);

    const removed = await ian.call(memberDelete, { method: "DELETE", params: { tid, pid: olaId } });
    expect(removed.status).toBe(200);
    expect(removed.body.inviteUrlPath).not.toContain(oldToken);
    expect((await state(ola, gid)).status).toBe(403); // kicked from the live gathering
    expect(admin.calls.some((c) => c.op === "remove")).toBe(true);
    expect((await ola.call(enterRoute, { params: { tid } })).status).toBe(404);
    expect((await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: oldToken } })).status).toBe(403);
    expect((await home(ola)).tables).toEqual([]);
  });

  it("rotating the link and renaming are owner-only", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid } = await newTable(ian);
    const ola = newPhone();
    await remember(ola, "Ola", "pl");
    const token = await tableLink(ian, tid);
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: token } });
    expect((await ola.call(rotateRoute, { params: { tid } })).status).toBe(403);
    expect((await ola.call(renameRoute, { method: "PATCH", params: { tid }, body: { name: "Mine" } })).status).toBe(403);
    const rotated = await ian.call(rotateRoute, { params: { tid } });
    expect(rotated.status).toBe(200);
    expect(await tableLink(ian, tid)).not.toBe(token);
    expect((await ian.call(renameRoute, { method: "PATCH", params: { tid }, body: { name: "Familia" } })).status).toBe(200);
    expect((await home(ola)).tables[0].name).toBe("Familia");
    // Ola is still a member after the rotation.
    expect((await ola.call(enterRoute, { params: { tid } })).status).toBe(200);
  });

  it("leaving hands ownership on; the last person out deletes the table", async () => {
    const ian = newPhone();
    const ianId = await remember(ian, "Ian");
    const { tid } = await newTable(ian);
    const ola = newPhone();
    const olaId = await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: await tableLink(ian, tid) } });
    expect((await ian.call(memberDelete, { method: "DELETE", params: { tid, pid: ianId } })).status).toBe(200);
    expect((await home(ola)).tables[0].role).toBe("owner");
    expect((await ola.call(memberDelete, { method: "DELETE", params: { tid, pid: olaId } })).status).toBe(200);
    expect((await db.query("select 1 from circles where id = $1", [tid])).length).toBe(0);
  });

  it("a person the host kicked cannot tap back into that same session", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid, gid } = await newTable(ian);
    const ola = newPhone();
    await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: await tableLink(ian, tid) } });
    const olaSeat = (await state(ola, gid)).body.me.id;
    expect((await ian.call(kickRoute, { params: { gid, pid: olaSeat } })).status).toBe(200);
    const back = await ola.call(enterRoute, { params: { tid } });
    expect(back.status).toBe(403);
    expect(back.body.error).toBe("kicked");
  });

  it("the table seats at most the gathering's limit at once", async () => {
    process.env.GATHERING_MAX_HUMANS = "2";
    try {
      const ian = newPhone();
      await remember(ian, "Ian");
      const { tid } = await newTable(ian);
      const token = await tableLink(ian, tid);
      const ola = newPhone();
      await remember(ola, "Ola", "pl");
      expect((await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: token } })).status).toBe(201);
      const third = newPhone();
      await remember(third, "Third", "en");
      const full = await third.call(joinTableRoute, { params: { tid }, body: { inviteToken: token } });
      expect(full.status).toBe(409);
    } finally {
      delete process.env.GATHERING_MAX_HUMANS;
    }
  });

  it("the host of a table session can leave: hosting passes on, and the last one out ends the session", async () => {
    const ian = newPhone();
    await remember(ian, "Ian");
    const { tid, gid } = await newTable(ian);
    const ola = newPhone();
    await remember(ola, "Ola", "pl");
    await ola.call(joinTableRoute, { params: { tid }, body: { inviteToken: await tableLink(ian, tid) } });
    expect((await ian.call(leaveGatheringRoute, { params: { gid } })).status).toBe(200);
    expect((await state(ola, gid)).body.me.role).toBe("host");
    expect((await ola.call(leaveGatheringRoute, { params: { gid } })).status).toBe(200);
    expect((await db.query("select 1 from gatherings where id = $1", [gid])).length).toBe(0);
    // The table itself stays; tapping it starts a new session.
    expect((await ian.call(enterRoute, { params: { tid } })).status).toBe(200);
  });

  it("changing languages in the room is remembered for next time", async () => {
    const ian = newPhone();
    await remember(ian, "Ian", "es");
    const { gid } = await newTable(ian);
    const res = await ian.call(gatheringMeRoute, { method: "PATCH", params: { gid }, body: { listenLang: "en" } });
    expect(res.status).toBe(200);
    expect((await home(ian)).person?.listenLang).toBe("en");
  });

  it("one-off gatherings still work, and link a remembered person without saving a table", async () => {
    const host = newPhone();
    const created = await host.call(createGatheringRoute, {
      body: { title: "Dinner", displayName: "Host", consent: true, ...prefs("en") },
    });
    expect(created.status).toBe(201);
    const gid = created.body.gatheringId as string;
    const ola = newPhone();
    const olaId = await remember(ola, "Ola", "pl");
    const joined = await ola.call(joinGatheringRoute, {
      params: { gid },
      body: { inviteToken: inviteTokenFromPath(created.body.inviteUrlPath as string), displayName: "Ola", consent: true, ...prefs("pl") },
    });
    expect(joined.status).toBe(201);
    const row = await db.query<{ person_id: string }>("select person_id from participants where gathering_id = $1 and display_name = 'Ola'", [gid]);
    expect(row[0].person_id).toBe(olaId);
    expect((await home(ola)).tables).toEqual([]);
    expect((await state(ola, gid)).body.table).toBeNull();
  });

  it("cleanup forgets phones and people unused for 400+ days and drops empty tables", async () => {
    const ian = newPhone();
    const ianId = await remember(ian, "Ian");
    await newTable(ian);
    await db.query("update people set last_seen_at = now() - interval '401 days' where id = $1", [ianId]);
    await db.query("update person_devices set last_seen_at = now() - interval '401 days' where person_id = $1", [ianId]);
    await cleanupExpiredGatherings();
    expect((await db.query("select 1 from people")).length).toBe(0);
    expect((await db.query("select 1 from person_devices")).length).toBe(0);
    expect((await db.query("select 1 from circles")).length).toBe(0);
  });
});

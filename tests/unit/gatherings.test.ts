/**
 * Control-plane authorization, privacy and lifecycle tests against a real
 * Postgres (PGlite) and the real route handlers. LiveKit is replaced by a
 * recorder that still mints genuine JWTs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createGatheringRoute } from "@/app/api/gatherings/route";
import { POST as joinRoute } from "@/app/api/gatherings/[gid]/join/route";
import { GET as stateRoute } from "@/app/api/gatherings/[gid]/state/route";
import { PATCH as meRoute } from "@/app/api/gatherings/[gid]/me/route";
import { POST as tokenRoute } from "@/app/api/gatherings/[gid]/token/route";
import { POST as createGroupRoute } from "@/app/api/gatherings/[gid]/groups/route";
import { POST as enterRoute } from "@/app/api/gatherings/[gid]/groups/[groupId]/enter/route";
import { POST as leaveGroupRoute } from "@/app/api/gatherings/[gid]/groups/[groupId]/leave/route";
import { POST as inviteRoute } from "@/app/api/gatherings/[gid]/groups/[groupId]/invite/route";
import { DELETE as removeMemberRoute } from "@/app/api/gatherings/[gid]/groups/[groupId]/members/[pid]/route";
import { POST as mainRoute } from "@/app/api/gatherings/[gid]/main/route";
import { POST as respondRoute } from "@/app/api/gatherings/[gid]/invitations/[invId]/route";
import { POST as kickRoute } from "@/app/api/gatherings/[gid]/participants/[pid]/kick/route";
import { POST as rotateRoute } from "@/app/api/gatherings/[gid]/invite/rotate/route";
import { POST as endRoute } from "@/app/api/gatherings/[gid]/end/route";
import { POST as admissionRoute } from "@/app/api/internal/admission/route";
import { POST as usageRoute } from "@/app/api/internal/usage/route";
import {
  Client,
  decodeJwt,
  FakeMediaAdmin,
  freshEnvironment,
  inviteTokenFromPath,
  signedRequest,
} from "./helpers";
import type { GatheringStateView, MediaTokenView } from "@/lib/api-types";
import type { Db } from "@/server/db";

let admin: FakeMediaAdmin;
let db: Db;

beforeEach(async () => {
  ({ admin, db } = await freshEnvironment());
});

const prefs = (speakLang: string, listenLang = speakLang === "auto" ? "en" : speakLang) => ({
  speakLang,
  listenLang,
  esRegion: "",
});

async function hostGathering(name = "Ian") {
  const host = new Client("198.51.100.1");
  const res = await host.call(createGatheringRoute, {
    body: { hostCode: "host-code-123", title: "Dinner", displayName: name, consent: true, ...prefs("es") },
  });
  expect(res.status).toBe(201);
  const gid = res.body.gatheringId as string;
  const invite = inviteTokenFromPath(res.body.inviteUrlPath as string);
  return { host, gid, invite, hostId: res.body.participantId as string };
}

async function join(gid: string, invite: string, name: string, lang = "pl", ip?: string) {
  const c = new Client(ip ?? `203.0.113.${Math.floor(Math.random() * 200) + 1}`);
  const res = await c.call(joinRoute, {
    params: { gid },
    body: { inviteToken: invite, displayName: name, consent: true, ...prefs(lang) },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { client: c, id: res.body.participantId as string };
}

async function state(c: Client, gid: string): Promise<GatheringStateView> {
  const res = await c.call(stateRoute, { method: "GET", params: { gid } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as GatheringStateView;
}

async function token(c: Client, gid: string): Promise<MediaTokenView> {
  const res = await c.call(tokenRoute, { params: { gid } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as MediaTokenView;
}

async function admit(room: string, identities: string[]) {
  const res = await admissionRoute(signedRequest({ room, identities }));
  return { status: res.status, body: await res.json() };
}

async function makeGroup(owner: Client, gid: string, name: string, invitees: string[]) {
  const res = await owner.call(createGroupRoute, { params: { gid }, body: { name, inviteeIds: invitees } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { groupId: string; media: MediaTokenView };
}

async function acceptInvite(c: Client, gid: string, groupId: string) {
  const s = await state(c, gid);
  const inv = s.invitations.find((i) => i.groupId === groupId);
  expect(inv, "invitation should be visible to invitee").toBeTruthy();
  const res = await c.call(respondRoute, { params: { gid, invId: inv!.id }, body: { action: "accept" } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { media: MediaTokenView }).media;
}

// --------------------------------------------------------------------------

describe("gathering creation and joining", () => {
  it("requires the host access code", async () => {
    const c = new Client();
    const bad = await c.call(createGatheringRoute, {
      body: { hostCode: "wrong", title: "x", displayName: "A", consent: true, ...prefs("en") },
    });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("bad_host_code");
  });

  it("refuses creation on a hosted deployment when no host code is configured", async () => {
    ({ admin, db } = await freshEnvironment({ HOST_ACCESS_CODE: undefined, VERCEL: "1", ALLOW_EMBEDDED_DB: "1" }));
    const c = new Client();
    const res = await c.call(createGatheringRoute, {
      body: { title: "x", displayName: "A", consent: true, ...prefs("en") },
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("host_code_not_configured");
  });

  it("requires explicit AI-processing consent", async () => {
    const c = new Client();
    const res = await c.call(createGatheringRoute, {
      body: { hostCode: "host-code-123", title: "x", displayName: "A", consent: false, ...prefs("en") },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("consent_required");
  });

  it("rejects a wrong invite token with the same error as an unknown gathering", async () => {
    const { gid } = await hostGathering();
    const c = new Client();
    const wrong = await c.call(joinRoute, {
      params: { gid },
      body: { inviteToken: "x".repeat(32), displayName: "Eve", consent: true, ...prefs("en") },
    });
    const unknown = await c.call(joinRoute, {
      params: { gid: "00000000-0000-4000-8000-000000000000" },
      body: { inviteToken: "x".repeat(32), displayName: "Eve", consent: true, ...prefs("en") },
    });
    expect(wrong.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it("admits at most eight humans", async () => {
    const { gid, invite } = await hostGathering();
    for (let i = 0; i < 7; i++) await join(gid, invite, `P${i}`);
    const ninth = new Client();
    const res = await ninth.call(joinRoute, {
      params: { gid },
      body: { inviteToken: invite, displayName: "Ninth", consent: true, ...prefs("en") },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("gathering_full");
  });

  it("rotating the invite invalidates the old link", async () => {
    const { host, gid, invite } = await hostGathering();
    const rotated = await host.call(rotateRoute, { params: { gid } });
    expect(rotated.status).toBe(200);
    const c = new Client();
    const old = await c.call(joinRoute, {
      params: { gid },
      body: { inviteToken: invite, displayName: "Late", consent: true, ...prefs("en") },
    });
    expect(old.status).toBe(403);
    await join(gid, inviteTokenFromPath(rotated.body.inviteUrlPath as string), "Late2");
  });

  it("rejects cross-origin state changes", async () => {
    const { host, gid } = await hostGathering();
    const res = await host.call(tokenRoute, { params: { gid }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad_origin");
  });

  it("rate-limits gathering creation per IP", async () => {
    const c = new Client("192.0.2.99");
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await c.call(createGatheringRoute, {
        body: { hostCode: "host-code-123", title: "x", displayName: "A", consent: true, ...prefs("en") },
      });
      last = r.status;
    }
    expect(last).toBe(429);
  });
});

describe("media tokens", () => {
  it("are scoped to the caller's current group with locked-down grants", async () => {
    const { host, gid } = await hostGathering();
    const t = await token(host, gid);
    const claims = decodeJwt(t.token) as {
      sub: string;
      exp: number;
      nbf?: number;
      video: Record<string, unknown>;
      attributes: Record<string, string>;
      roomConfig: { agents: { agentName: string; metadata: string }[]; maxParticipants: number };
    };
    expect(claims.video.room).toBe(t.room);
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.video.canPublishData).toBe(false);
    expect(claims.video.canUpdateOwnMetadata).toBe(false);
    expect(claims.video.canPublishSources).toEqual(["microphone"]);
    expect(claims.video.roomAdmin).toBeUndefined();
    expect(claims.attributes.speak_lang).toBe("es");
    expect(claims.attributes.epoch).toBe(String(t.epoch));
    expect(claims.roomConfig.agents[0].agentName).toBe("gemini-translator");
    expect(JSON.parse(claims.roomConfig.agents[0].metadata).groupId).toBe(t.groupId);
    expect(claims.roomConfig.maxParticipants).toBe(10);
    const ttl = claims.exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(500);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(t.room).toMatch(/^grp_[a-z2-7]{24}$/);
  });

  it("cannot be obtained without the gathering cookie", async () => {
    const { gid } = await hostGathering();
    const stranger = new Client();
    const res = await stranger.call(tokenRoute, { params: { gid } });
    expect(res.status).toBe(401);
  });
});

describe("private groups", () => {
  it("hides private group names and members from non-members", async () => {
    const { host, gid, invite } = await hostGathering("Ian");
    const kasia = await join(gid, invite, "Kasia");
    const outsider = await join(gid, invite, "Marek");
    const g = await makeGroup(host, gid, "Smoking outside", [kasia.id]);
    await acceptInvite(kasia.client, gid, g.groupId);

    const s = await state(outsider.client, gid);
    expect(s.groups.map((x) => x.kind)).toEqual(["main"]);
    const ian = s.participants.find((p) => p.displayName === "Ian")!;
    expect(ian.location).toEqual({ type: "private" });
    expect(JSON.stringify(s)).not.toContain("Smoking outside");

    const inside = await state(kasia.client, gid);
    const grp = inside.groups.find((x) => x.id === g.groupId)!;
    expect(grp.name).toBe("Smoking outside");
    expect(grp.members.map((m) => m.displayName).sort()).toEqual(["Ian", "Kasia"]);
  });

  it("non-members cannot enter a private group or tell it apart from a missing one", async () => {
    const { host, gid, invite } = await hostGathering();
    const outsider = await join(gid, invite, "Marek");
    const g = await makeGroup(host, gid, "Private", []);
    const res = await outsider.client.call(enterRoute, { params: { gid, groupId: g.groupId } });
    const missing = await outsider.client.call(enterRoute, {
      params: { gid, groupId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(res.body.error).toBe(missing.body.error);
    // And a token request still yields only their own (main) room.
    const t = await token(outsider.client, gid);
    expect(t.room).not.toBe(g.media.room);
  });

  it("moving evicts the old room server-side, bumps the epoch and makes old tokens fail admission", async () => {
    const { host, gid, hostId } = await hostGathering();
    const before = await token(host, gid);
    const g = await makeGroup(host, gid, "Kitchen", []);
    expect(g.media.room).not.toBe(before.room);
    expect(g.media.epoch).toBe(before.epoch + 1);
    expect(admin.removals(hostId)).toContain(before.room);

    // Replay: old main-room token's identity is no longer authorized there.
    const old = await admit(before.room, [hostId]);
    expect(old.status).toBe(200);
    expect(old.body.participants[hostId]).toMatchObject({ allowed: false, reason: "not_in_group" });
    const now = await admit(g.media.room, [hostId]);
    expect(now.body.participants[hostId]).toMatchObject({ allowed: true, epoch: g.media.epoch });
  });

  it("invitation accept moves the invitee; decline does not", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const b = await join(gid, invite, "B");
    const g = await makeGroup(host, gid, "Outside", [a.id, b.id]);
    const mA = await acceptInvite(a.client, gid, g.groupId);
    expect(mA.room).toBe(g.media.room);

    const sB = await state(b.client, gid);
    const invB = sB.invitations.find((i) => i.groupId === g.groupId)!;
    expect(invB.memberNames.sort()).toEqual(["A", "Ian"]);
    const dec = await b.client.call(respondRoute, { params: { gid, invId: invB.id }, body: { action: "decline" } });
    expect(dec.status).toBe(200);
    const tB = await token(b.client, gid);
    expect(tB.room).not.toBe(g.media.room);
    // Declined invitation cannot be accepted afterwards.
    const again = await b.client.call(respondRoute, { params: { gid, invId: invB.id }, body: { action: "accept" } });
    expect(again.status).toBe(404);
  });

  it("only members can invite; owner can remove; removed member is moved to main and evicted", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const outsider = await join(gid, invite, "O");
    const g = await makeGroup(host, gid, "Outside", [a.id]);
    await acceptInvite(a.client, gid, g.groupId);

    const sneaky = await outsider.client.call(inviteRoute, {
      params: { gid, groupId: g.groupId },
      body: { participantIds: [outsider.id] },
    });
    expect(sneaky.status).toBe(404);

    const notOwner = await a.client.call(removeMemberRoute, {
      method: "DELETE",
      params: { gid, groupId: g.groupId, pid: outsider.id },
    });
    expect(notOwner.status).toBe(403);

    const removed = await host.call(removeMemberRoute, { method: "DELETE", params: { gid, groupId: g.groupId, pid: a.id } });
    expect(removed.status).toBe(200);
    expect(admin.removals(a.id)).toContain(g.media.room);
    const adm = await admit(g.media.room, [a.id]);
    expect(adm.body.participants[a.id].allowed).toBe(false);
    const back = await a.client.call(enterRoute, { params: { gid, groupId: g.groupId } });
    expect(back.status).toBe(404);
    const tA = await token(a.client, gid);
    const main = (await state(a.client, gid)).groups.find((x) => x.kind === "main")!;
    expect(tA.groupId).toBe(main.id);
  });

  it("closes an emptied group, deletes its room and revokes pending invitations", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const g = await makeGroup(host, gid, "Brief", [a.id]);
    const back = await host.call(mainRoute, { params: { gid } });
    expect(back.status).toBe(200);
    expect(admin.calls.some((c) => c.op === "deleteRoom" && c.room === g.media.room)).toBe(true);
    const sA = await state(a.client, gid);
    expect(sA.invitations).toHaveLength(0);
    const adm = await admit(g.media.room, [a.id]);
    expect(Object.values(adm.body.participants as Record<string, { allowed: boolean }>)[0].allowed).toBe(false);
  });

  it("leaving a private group returns you to main", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const g = await makeGroup(host, gid, "Two", [a.id]);
    await acceptInvite(a.client, gid, g.groupId);
    const res = await a.client.call(leaveGroupRoute, { params: { gid, groupId: g.groupId } });
    expect(res.status).toBe(200);
    const main = (await state(a.client, gid)).groups.find((x) => x.kind === "main")!;
    expect(res.body.groupId).toBe(main.id);
  });

  it.each([
    ["5+3", [5, 3]],
    ["4+4", [4, 4]],
    ["3+3+2", [3, 3, 2]],
    ["2+2+2+2", [2, 2, 2, 2]],
  ])("partition %s isolates every room to its own members", async (_label, sizes) => {
    const { host, gid, invite, hostId } = await hostGathering("P0");
    const people: { client: Client; id: string }[] = [{ client: host, id: hostId }];
    for (let i = 1; i < 8; i++) people.push(await join(gid, invite, `P${i}`, ["en", "pl", "es"][i % 3]));

    // First block stays in main; every other block creates its own private group.
    let cursor = sizes[0];
    const groupsBySize: { members: typeof people; room: string }[] = [];
    const mainRoom = (await token(host, gid)).room;
    groupsBySize.push({ members: people.slice(0, sizes[0]), room: mainRoom });
    for (const size of sizes.slice(1)) {
      const members = people.slice(cursor, cursor + size);
      cursor += size;
      const [owner, ...rest] = members;
      const g = await makeGroup(owner.client, gid, `G${cursor}`, rest.map((m) => m.id));
      for (const m of rest) await acceptInvite(m.client, gid, g.groupId);
      groupsBySize.push({ members, room: g.media.room });
    }

    const allIds = people.map((p) => p.id);
    for (const grp of groupsBySize) {
      // Each member's freshly minted token points at their own room only.
      for (const m of grp.members) expect((await token(m.client, gid)).room).toBe(grp.room);
      // Admission for the room allows exactly its members and nobody else.
      const adm = await admit(grp.room, allIds);
      const allowed = Object.entries(adm.body.participants as Record<string, { allowed: boolean }>)
        .filter(([, v]) => v.allowed)
        .map(([k]) => k)
        .sort();
      expect(allowed).toEqual(grp.members.map((m) => m.id).sort());
    }
  });

  it("rapid back-and-forth moves leave exactly one active group with a strictly newer epoch", async () => {
    const { host, gid } = await hostGathering();
    const g = await makeGroup(host, gid, "Ping", []);
    const main = (await state(host, gid)).groups.find((x) => x.kind === "main")!;
    // Private group closes as soon as the owner leaves, so alternate main <-> new groups.
    const results = await Promise.all([
      host.call(enterRoute, { params: { gid, groupId: main.id } }),
      host.call(enterRoute, { params: { gid, groupId: main.id } }),
      host.call(tokenRoute, { params: { gid } }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
    const s = await state(host, gid);
    expect(s.me.activeGroupId).toBe(main.id);
    expect(s.me.epoch).toBeGreaterThan(g.media.epoch);
    const rows = await db.query<{ n: number }>(
      "select count(*)::int as n from group_members where participant_id = $1",
      [s.me.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("host controls", () => {
  it("kicked participants lose their session and admission", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const room = (await token(a.client, gid)).room;
    const res = await host.call(kickRoute, { params: { gid, pid: a.id } });
    expect(res.status).toBe(200);
    expect(admin.removals(a.id)).toContain(room);
    const after = await a.client.call(stateRoute, { method: "GET", params: { gid } });
    expect(after.status).toBe(403);
    const adm = await admit(room, [a.id]);
    expect(adm.body.participants[a.id]).toMatchObject({ allowed: false, reason: "kicked" });
  });

  it("guests cannot use host controls", async () => {
    const { gid, invite, hostId } = await hostGathering();
    const a = await join(gid, invite, "A");
    const res = await a.client.call(kickRoute, { params: { gid, pid: hostId } });
    expect(res.status).toBe(403);
  });

  it("ending deletes personal data, closes every room and keeps anonymous usage", async () => {
    const { host, gid, invite } = await hostGathering();
    const a = await join(gid, invite, "A");
    const room = (await token(a.client, gid)).room;
    await usageRoute(
      signedRequest({ room, records: [{ speakerId: a.id, targetLang: "es", provider: "gemini", inputSeconds: 60, outputSeconds: 60, sessionSeconds: 60 }] }),
    );
    const res = await host.call(endRoute, { params: { gid } });
    expect(res.status).toBe(200);
    expect(admin.calls.some((c) => c.op === "deleteRoom" && c.room === room)).toBe(true);
    expect(admin.calls.some((c) => c.op === "data" && (c.payload as { t: string }).t === "ended")).toBe(true);
    const names = await db.query("select display_name from participants where gathering_id = $1", [gid]);
    expect(names).toHaveLength(0);
    const usage = await db.query<{ n: number }>("select count(*)::int as n from usage_records where gathering_id = $1", [gid]);
    expect(usage[0].n).toBe(1);
    const after = await a.client.call(stateRoute, { method: "GET", params: { gid } });
    expect(after.status).toBe(401);
  });
});

describe("preferences", () => {
  it("pushes server-authoritative attributes to the live room", async () => {
    const { host, gid, hostId } = await hostGathering();
    const t = await token(host, gid);
    const res = await host.call(meRoute, { method: "PATCH", params: { gid }, body: { speakLang: "auto", listenLang: "pl" } });
    expect(res.status).toBe(200);
    const call = admin.calls.find((c) => c.op === "attrs" && c.identity === hostId);
    expect(call?.room).toBe(t.room);
    expect(call?.attributes).toMatchObject({ speak_lang: "auto", listen_lang: "pl", epoch: String(t.epoch) });
  });

  it("validates languages", async () => {
    const { host, gid } = await hostGathering();
    const res = await host.call(meRoute, { method: "PATCH", params: { gid }, body: { listenLang: "de" } });
    expect(res.status).toBe(400);
  });
});

describe("internal worker API", () => {
  it("rejects bad signatures and stale timestamps", async () => {
    const { gid, host } = await hostGathering();
    const room = (await token(host, gid)).room;
    const bad = await admissionRoute(signedRequest({ room, identities: [] }, "wrong-secret"));
    expect(bad.status).toBe(401);
    const stale = await admissionRoute(signedRequest({ room, identities: [] }, "internal-secret", Math.floor(Date.now() / 1000) - 600));
    expect(stale.status).toBe(401);
  });

  it("returns 404 for unknown rooms", async () => {
    const res = await admissionRoute(signedRequest({ room: "grp_" + "a".repeat(24), identities: ["x"] }));
    expect(res.status).toBe(404);
  });

  it("prices usage and stops translation at the gathering cap", async () => {
    ({ admin, db } = await freshEnvironment({ MAX_AI_SPEND_PER_GATHERING_USD: "1" }));
    const { host, gid, hostId } = await hostGathering();
    const room = (await token(host, gid)).room;
    const r1 = await usageRoute(
      signedRequest({
        room,
        records: [{ speakerId: hostId, targetLang: "pl", provider: "gemini", inputSeconds: 600, outputSeconds: 600, sessionSeconds: 600, firstAudioMs: [1800, 2400] }],
      }),
    );
    const b1 = await r1.json();
    // 10 min * (0.0053 + 0.0315) = 0.368 USD
    expect(b1.spend.gatheringUsd).toBeCloseTo(0.368, 3);
    expect(b1.translation.allowed).toBe(true);
    let last: { translation: { allowed: boolean; reason: string } } = b1;
    for (let i = 0; i < 2; i++) {
      const r = await usageRoute(
        signedRequest({ room, records: [{ speakerId: hostId, targetLang: "pl", provider: "gemini", inputSeconds: 600, outputSeconds: 600, sessionSeconds: 600 }] }),
      );
      last = await r.json();
    }
    expect(last.translation).toEqual({ allowed: false, reason: "gathering_cap" });
    const adm = await admit(room, [hostId]);
    expect(adm.body.translation.allowed).toBe(false);
    const s = await state(host, gid);
    expect(s.budget.translationAllowed).toBe(false);
  });

  it("enforces the monthly cap across gatherings", async () => {
    ({ admin, db } = await freshEnvironment({ MAX_AI_SPEND_MONTHLY_USD: "0.5" }));
    const one = await hostGathering();
    const room1 = (await token(one.host, one.gid)).room;
    await usageRoute(signedRequest({ room: room1, records: [{ speakerId: one.hostId, targetLang: "en", provider: "openai", inputSeconds: 0, outputSeconds: 0, sessionSeconds: 900 }] }));
    const two = await hostGathering("Other");
    const room2 = (await token(two.host, two.gid)).room;
    const adm = await admit(room2, [two.hostId]);
    expect(adm.body.translation).toMatchObject({ allowed: false, reason: "monthly_cap" });
  });

  it("clamps absurd usage values", async () => {
    const { host, gid, hostId } = await hostGathering();
    const room = (await token(host, gid)).room;
    const r = await usageRoute(
      signedRequest({ room, records: [{ speakerId: hostId, targetLang: "pl", provider: "gemini", inputSeconds: -5, outputSeconds: 1e12, sessionSeconds: "x" }] }),
    );
    const body = await r.json();
    // output clamped to 3600 s -> 60 min * 0.0315
    expect(body.spend.gatheringUsd).toBeCloseTo(1.89, 2);
  });
});

/**
 * End-to-end tests of the real stack with real browsers and real WebRTC:
 * Chrome (fake mic from WAV) -> LiveKit server -> Python worker (mock
 * translator: delayed passthrough) -> translated track -> listener's Web
 * Audio mixer. The mock makes runs deterministic and free; it proves the
 * streaming plumbing, routing, overlap handling and group isolation — NOT
 * Gemini/OpenAI translation quality or real-provider latency.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const HOST_CODE = process.env.E2E_HOST_CODE ?? "e2e-host-code";
const PYTHON = process.env.E2E_PYTHON ?? "python";
const FIX = (n: string) => path.resolve(__dirname, "fixtures", n);
const METRICS = path.resolve("test-results", "e2e-metrics.json");

type Lang = "English" | "Polski" | "Español";

interface Mesa {
  snapshot: () => {
    status: string;
    humans: { id: string; name: string }[];
    agentPresent: boolean;
    micLive: boolean;
    meSpeaking: boolean;
    roomName: string | null;
    groupId: string | null;
    lastSwitchMs: number | null;
  };
  mixer: () => { key: string; speakerId: string; kind: string; active: boolean; gain: number }[];
  captions: () => { speakerId: string; kind: string; text: string }[];
  latency: () => { client: { count: number; p50: number | null; p95: number | null }; samples: { ms: number; overlap: boolean }[] };
  room: () => string | null;
  subscribed: () => { from: string; kind: string; track: string }[];
}
declare global {
  interface Window {
    __mesa?: Mesa;
  }
}

const browsers: Browser[] = [];
const metrics: Record<string, unknown> = fs.existsSync(METRICS) ? JSON.parse(fs.readFileSync(METRICS, "utf8")) : {};
function record(key: string, value: unknown) {
  metrics[key] = value;
  fs.mkdirSync(path.dirname(METRICS), { recursive: true });
  fs.writeFileSync(METRICS, JSON.stringify(metrics, null, 2));
}

async function launch(audio: string): Promise<Browser> {
  const b = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FIX(audio)}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  browsers.push(b);
  return b;
}

async function participant(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  return { ctx, page };
}

async function hostCreates(page: Page, name: string, speak: Lang) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start a gathering" }).click();
  await page.getByPlaceholder("Sunday dinner").fill("E2E dinner");
  await page.getByPlaceholder("Ian").fill(name);
  await page.getByPlaceholder("Set by the app owner").fill(HOST_CODE);
  await page.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: speak }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create & get invite" }).click();
  await page.waitForURL(/\/g\/[0-9a-f-]{36}/);
  const link = (await page.locator(".link-box").textContent())!.trim();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  const gid = new URL(page.url()).pathname.split("/")[2];
  return { link, gid };
}

async function guestJoins(page: Page, link: string, name: string, speak: Lang) {
  await page.goto(link);
  await page.getByPlaceholder("Kasia").fill(name);
  await page.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: speak }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Join the table" }).click();
  await page.waitForURL(/\/g\/[0-9a-f-]{36}$/);
}

const connected = (page: Page) =>
  page.waitForFunction(() => window.__mesa?.snapshot().status === "connected", null, { timeout: 45_000 });

async function micOn(page: Page) {
  await page.getByRole("button", { name: "Turn on microphone" }).click();
  await page.waitForFunction(() => window.__mesa?.snapshot().micLive === true, null, { timeout: 15_000 });
}

const me = (page: Page) =>
  page.evaluate(async () => {
    const gid = location.pathname.split("/")[2];
    const s = await fetch(`/api/gatherings/${gid}/state`).then((r) => r.json());
    return s.me.id as string;
  });

test.afterEach(async () => {
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------

test("translated audio starts while a 30 s monologue is still being spoken (es speaker, pl listener)", async () => {
  const hostB = await launch("monologue_30s.wav");
  const guestB = await launch("silence_30s.wav");
  const host = await participant(hostB);
  const guest = await participant(guestB);

  const { link } = await hostCreates(host.page, "Ian", "Español");
  await connected(host.page);
  await guestJoins(guest.page, link, "Kasia", "Polski");
  await connected(guest.page);
  await guest.page.waitForFunction(() => {
    const s = window.__mesa!.snapshot();
    return s.humans.length === 1 && s.agentPresent;
  }, null, { timeout: 45_000 });
  const hostId = await me(host.page);

  const t0 = Date.now();
  await micOn(host.page); // the fake mic now plays the ~34 s monologue from the start
  await guest.page.waitForFunction(
    (id) => window.__mesa!.mixer().some((m) => m.kind === "translation" && m.speakerId === id && m.active),
    hostId,
    { timeout: 30_000 },
  );
  const firstAudibleMs = Date.now() - t0;

  const subs = await guest.page.evaluate(() => window.__mesa!.subscribed());
  expect(subs.some((s) => s.track === `tx:${hostId}:pl`)).toBe(true);
  // Never both: the Spanish speaker's own microphone is not played to the Polish listener.
  expect(subs.some((s) => s.from === hostId)).toBe(false);
  // The monologue is ~34 s long; translation must be flowing long before it ends.
  expect(firstAudibleMs).toBeLessThan(20_000);

  // Keep listening: translation stays active during continued speech (no turn gating).
  await guest.page.waitForTimeout(8_000);
  const activeAgain = await guest.page.evaluate(
    (id) => window.__mesa!.mixer().filter((m) => m.speakerId === id && m.kind === "translation"),
    hostId,
  );
  expect(activeAgain.length).toBe(1);
  const lat = await guest.page.evaluate(() => window.__mesa!.latency());
  const captions = await guest.page.evaluate(() => window.__mesa!.captions());
  record("monologue", {
    provider: "mock (delayed passthrough)",
    micOnToFirstAudibleTranslationMs: firstAudibleMs,
    clientLatency: lat.client,
    captionEntries: captions.length,
  });
});

test("short interjection is heard while the main speaker keeps talking, and the listener ducks the monologue", async () => {
  const mainB = await launch("monologue_30s.wav");
  const interB = await launch("interjection_at_8s.wav");
  const quietB = await launch("silence_30s.wav");
  const ian = await participant(mainB);
  const kasia = await participant(interB);
  const tom = await participant(quietB);

  const { link } = await hostCreates(ian.page, "Ian", "Español");
  await connected(ian.page);
  await guestJoins(kasia.page, link, "Kasia", "Polski");
  await guestJoins(tom.page, link, "Tom", "English");
  for (const p of [kasia.page, tom.page]) await connected(p);
  for (const p of [ian.page, kasia.page, tom.page]) {
    await p.waitForFunction(() => window.__mesa!.snapshot().humans.length === 2 && window.__mesa!.snapshot().agentPresent, null, {
      timeout: 45_000,
    });
  }
  const ianId = await me(ian.page);
  const kasiaId = await me(kasia.page);

  const t0 = Date.now();
  await Promise.all([micOn(ian.page), micOn(kasia.page), micOn(tom.page)]);

  // Ian (still talking) hears Kasia's translated "What? Seriously?" (pl->es track).
  await ian.page.waitForFunction(
    (id) => window.__mesa!.mixer().some((m) => m.speakerId === id && m.kind === "translation" && m.active),
    kasiaId,
    { timeout: 40_000 },
  );
  const interjectionHeardAtMs = Date.now() - t0;
  const ianStillLive = await ian.page.evaluate(() => window.__mesa!.snapshot().micLive);
  expect(ianStillLive).toBe(true);
  expect(interjectionHeardAtMs).toBeLessThan(30_000); // before Ian's ~34 s monologue ends

  // Tom (third person) hears both; while the interjection plays the monologue is ducked, not muted.
  const overlap = await tom.page.waitForFunction(
    ([main, inter]) => {
      const m = window.__mesa!.mixer();
      const a = m.find((x) => x.speakerId === main && x.kind === "translation");
      const b = m.find((x) => x.speakerId === inter && x.kind === "translation");
      return a && b && a.active && b.active && a.gain < 0.75 && a.gain > 0.1 && b.gain > 0.9 ? { main: a.gain, inter: b.gain } : null;
    },
    [ianId, kasiaId],
    { timeout: 40_000, polling: 50 },
  );
  const gains = await overlap.jsonValue();
  record("interjection", {
    provider: "mock (delayed passthrough)",
    interjectionHeardByMainSpeakerAtMsFromMicOn: interjectionHeardAtMs,
    thirdListenerGainsDuringOverlap: gains,
  });
});

test("private group isolates audio, old tokens are evicted, and members can return to main", async () => {
  const b = await launch("silence_30s.wav");
  const ian = await participant(b);
  const kasia = await participant(b);
  const tom = await participant(b);

  const { link, gid } = await hostCreates(ian.page, "Ian", "Español");
  await connected(ian.page);
  await guestJoins(kasia.page, link, "Kasia", "Polski");
  await guestJoins(tom.page, link, "Tom", "English");
  for (const p of [kasia.page, tom.page]) await connected(p);
  await ian.page.waitForFunction(() => window.__mesa!.snapshot().humans.length === 2, null, { timeout: 30_000 });
  const kasiaId = await me(kasia.page);

  // Kasia's current (main room) token — what an attacker would try to replay after she leaves.
  const oldToken = await kasia.page.evaluate(async (g) => {
    const r = await fetch(`/api/gatherings/${g}/token`, { method: "POST" });
    return r.json();
  }, gid);

  // Ian starts "Outside" with Kasia.
  const tSwitch = Date.now();
  await ian.page.getByRole("button", { name: "Conversations" }).first().click();
  await ian.page.getByRole("button", { name: /Start a private conversation/ }).click();
  await ian.page.getByPlaceholder("Outside").fill("Outside");
  await ian.page.getByRole("dialog").getByText("Kasia").click();
  await ian.page.getByRole("button", { name: "Start conversation" }).click();
  await kasia.page.getByRole("button", { name: "Join now" }).click({ timeout: 20_000 });
  for (const p of [ian.page, kasia.page]) {
    await p.waitForFunction(() => window.__mesa!.snapshot().status === "connected" && window.__mesa!.snapshot().humans.length === 1, null, {
      timeout: 30_000,
    });
  }
  const switchMs = Date.now() - tSwitch;
  const [rIan, rKasia, rTom] = await Promise.all([ian.page, kasia.page, tom.page].map((p) => p.evaluate(() => window.__mesa!.room())));
  expect(rIan).toBe(rKasia);
  expect(rTom).not.toBe(rIan);
  await tom.page.waitForFunction(() => window.__mesa!.snapshot().humans.length === 0, null, { timeout: 30_000 });
  const tomSubs = await tom.page.evaluate(() => window.__mesa!.subscribed());
  expect(tomSubs).toEqual([]);
  // Nothing about "Outside" is visible to Tom.
  const tomState = await tom.page.evaluate(async (g) => (await fetch(`/api/gatherings/${g}/state`)).text(), gid);
  expect(tomState).not.toContain("Outside");

  // Tom cannot enter the private group even with its id.
  const outsideId = await ian.page.evaluate(() => window.__mesa!.snapshot().groupId);
  const denied = await tom.page.evaluate(
    async ([g, grp]) => (await fetch(`/api/gatherings/${g}/groups/${grp}/enter`, { method: "POST" })).status,
    [gid, outsideId!],
  );
  expect(denied).toBe(404);

  // Replay Kasia's old main-room token from outside the browser: the worker must evict it.
  const probe = path.resolve(__dirname, "replay_probe.py");
  const out = execFileSync(PYTHON, [probe, oldToken.serverUrl, oldToken.token, "40"], { encoding: "utf8", timeout: 70_000 });
  const replay = JSON.parse(out.trim().split("\n").pop()!);
  expect(replay.connected).toBe(true);
  expect(replay.evicted).toBe(true);

  // Kasia goes back to the main conversation with one tap.
  await kasia.page.getByRole("button", { name: "Conversations" }).first().click();
  await kasia.page.getByRole("button", { name: "Leave & return to main" }).click();
  await kasia.page.waitForFunction(() => window.__mesa!.snapshot().status === "connected" && window.__mesa!.snapshot().humans.length === 1, null, {
    timeout: 30_000,
  });
  expect(await kasia.page.evaluate(() => window.__mesa!.room())).toBe(rTom);
  await tom.page.waitForFunction((id) => window.__mesa!.snapshot().humans.some((h) => h.id === id), kasiaId, { timeout: 30_000 });

  record("breakout", { switchToPrivateMs: switchMs, replayEvictedAfterMs: replay.evictedAfterMs, replayReason: replay.reason });
});

test("eight people join one gathering and split 5 + 3 with no cross-group media", async () => {
  test.setTimeout(300_000);
  const talk = await launch("monologue_b_30s.wav");
  const quiet = await launch("silence_30s.wav");
  const langs: Lang[] = ["Español", "Polski", "English", "Español", "Polski", "English", "Español", "Polski"];
  const people: { page: Page; id?: string }[] = [];
  for (let i = 0; i < 8; i++) people.push(await participant(i % 2 === 0 ? talk : quiet));

  const { link } = await hostCreates(people[0].page, "P0", langs[0]);
  await connected(people[0].page);
  for (let i = 1; i < 8; i++) {
    await guestJoins(people[i].page, link, `P${i}`, langs[i]);
    await connected(people[i].page);
  }
  for (const p of people) {
    await p.page.waitForFunction(() => window.__mesa!.snapshot().humans.length === 7, null, { timeout: 60_000 });
    p.id = await me(p.page);
  }

  // P5 starts "Outside" with P6 and P7.
  const owner = people[5].page;
  await owner.getByRole("button", { name: "Conversations" }).first().click();
  await owner.getByRole("button", { name: /Start a private conversation/ }).click();
  await owner.getByPlaceholder("Outside").fill("Outside");
  await owner.getByRole("dialog").getByText("P6").click();
  await owner.getByRole("dialog").getByText("P7").click();
  await owner.getByRole("button", { name: "Start conversation" }).click();
  for (const i of [6, 7]) await people[i].page.getByRole("button", { name: "Join now" }).click({ timeout: 30_000 });

  const outside = new Set(people.slice(5).map((p) => p.id!));
  const inside = new Set(people.slice(0, 5).map((p) => p.id!));
  for (let i = 0; i < 8; i++) {
    const expected = i >= 5 ? 2 : 4;
    await people[i].page.waitForFunction(
      (n) => window.__mesa!.snapshot().status === "connected" && window.__mesa!.snapshot().humans.length === n,
      expected,
      { timeout: 60_000 },
    );
  }
  // Two agents (one per room) are present.
  for (const i of [0, 5]) {
    await people[i].page.waitForFunction(() => window.__mesa!.snapshot().agentPresent, null, { timeout: 60_000 });
  }
  // Talkers speak (P0, P2, P4 inside; P6 outside).
  await Promise.all(people.filter((_, i) => i % 2 === 0).map((p) => micOn(p.page)));
  // Positive control first: translation really flows inside BOTH groups —
  // P1 (pl) hears P0 (es) translated, P5 (en) hears P6 (es) translated.
  await people[1].page.waitForFunction(
    (id) => window.__mesa!.subscribed().some((s) => s.track === `tx:${id}:pl`),
    people[0].id!,
    { timeout: 60_000 },
  );
  await people[5].page.waitForFunction(
    (id) => window.__mesa!.subscribed().some((s) => s.track === `tx:${id}:en`),
    people[6].id!,
    { timeout: 60_000 },
  );
  await people[1].page.waitForTimeout(4_000);
  const report: { participant: string; subscribedFrom: string[] }[] = [];
  for (let i = 0; i < 8; i++) {
    const subs = await people[i].page.evaluate(() => window.__mesa!.subscribed());
    const speakers = subs.map((s) => (s.kind === "agent" || s.track.startsWith("tx") ? s.track.split(":")[1] : s.from));
    const own = i >= 5 ? outside : inside;
    for (const sp of speakers) expect(own.has(sp), `P${i} heard ${sp} from the other group`).toBe(true);
    report.push({ participant: `P${i}`, subscribedFrom: [...new Set(speakers)] });
  }
  record("eight_people_5_plus_3", { rooms: 2, subscriptions: report });
});

/**
 * Walk the DEPLOYED app like two people would, using only what is on screen
 * (production builds have no test hooks): real Chrome with fake microphones,
 * real LiveKit Cloud, the deployed worker and real Gemini.
 *
 *   E2E_SPEAKER_WAV=<abs path to a Spanish clip> pnpm exec playwright test -c playwright.prod.config.ts
 *
 * Costs a little provider time. The gathering is ended at the end.
 */
import path from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const SPEAKER_WAV = process.env.E2E_SPEAKER_WAV ?? path.resolve(__dirname, "..", "e2e", "fixtures", "monologue_30s.wav");
const SILENT_WAV = path.resolve(__dirname, "..", "e2e", "fixtures", "silence_30s.wav");
const browsers: Browser[] = [];
const errors: string[] = [];

async function phone(wav: string): Promise<Page> {
  const b = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  browsers.push(b);
  const ctx = await b.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  return page;
}

const people = (page: Page) => page.getByRole("region", { name: "People in this conversation" });
const captions = (page: Page) => page.getByRole("region", { name: "Live captions" }).locator(".captions");

test.afterAll(async () => {
  await Promise.all(browsers.map((b) => b.close()));
});

test("two phones: create without a code, join by link, live translated captions, private conversation", async () => {
  test.setTimeout(240_000);
  const ian = await phone(SPEAKER_WAV);
  const kasia = await phone(SILENT_WAV);

  // Ian starts a gathering: no host-code field any more.
  await ian.goto("/");
  await ian.getByRole("button", { name: "Start a table" }).click();
  await expect(ian.getByPlaceholder("Set by the app owner")).toHaveCount(0);
  await ian.getByPlaceholder("Sunday dinner").fill("Walk test");
  await ian.getByPlaceholder("Ian").fill("Ian");
  await ian.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: "Español" }).click();
  await ian.getByRole("group", { name: "Language I want to hear" }).getByRole("button", { name: "Español" }).click();
  await ian.getByRole("group", { name: "Spanish regional preference" }).getByRole("button", { name: "Argentina" }).click();
  await ian.getByRole("checkbox", { name: /I am an adult/ }).check();
  await ian.getByRole("button", { name: "Create & get invite" }).click();
  await ian.waitForURL(/\/g\/[0-9a-f-]{36}/);
  const gid = new URL(ian.url()).pathname.split("/")[2];
  const link = (await ian.locator(".link-box").textContent())!.trim();
  expect(link).toContain("#k=");
  await ian.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  // Kasia joins from the invite link.
  await kasia.goto(link);
  await kasia.getByPlaceholder("Kasia").fill("Kasia");
  await kasia.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: "Polski" }).click();
  await kasia.getByRole("group", { name: "Language I want to hear" }).getByRole("button", { name: "Polski" }).click();
  await kasia.getByRole("button", { name: "Continue" }).click();
  await kasia.getByRole("button", { name: /Check my headset/ }).click();
  await expect(kasia.getByRole("button", { name: /Record & play/ })).toBeVisible();
  await expect(kasia.getByLabel("Microphone level")).toBeVisible();
  await kasia.getByRole("button", { name: "Continue" }).click();
  await kasia.getByRole("checkbox", { name: /I am an adult/ }).check();
  await kasia.getByRole("button", { name: "Join the table" }).click();
  await kasia.waitForURL(/\/g\/[0-9a-f-]{36}$/);

  try {
    // Both see each other.
    await expect(people(ian)).toContainText("Kasia", { timeout: 45_000 });
    await expect(people(kasia)).toContainText("Ian", { timeout: 45_000 });

    // Mics on (both start muted). Ian's fake mic plays a Spanish monologue.
    await kasia.getByRole("button", { name: "Turn on microphone" }).click();
    await ian.getByRole("button", { name: "Turn on microphone" }).click();
    const micOnAt = Date.now();
    await expect(ian.getByRole("button", { name: "Mute microphone" })).toBeVisible({ timeout: 15_000 });

    // Kasia hears Ian translated and sees Polish captions while he talks.
    await expect(kasia.getByRole("button", { name: /Ian, translated/ })).toBeVisible({ timeout: 45_000 });
    await expect(captions(kasia)).not.toBeEmpty({ timeout: 60_000 });
    const captionSeconds = (Date.now() - micOnAt) / 1000;
    await kasia.waitForTimeout(8_000);
    const text = ((await captions(kasia).textContent()) ?? "").trim();
    expect(text.length).toBeGreaterThan(20);
    console.log(`first caption on Kasia's screen ${captionSeconds.toFixed(1)} s after Ian's mic on; ${text.length} chars after 8 s more`);

    // Private conversation: Ian invites Kasia to "Outside".
    await ian.getByRole("button", { name: "Conversations" }).first().click();
    await ian.getByRole("button", { name: /Start a private conversation/ }).click();
    await ian.getByPlaceholder("Outside").fill("Outside");
    await ian.getByRole("dialog").getByText("Kasia").click();
    await ian.getByRole("button", { name: "Start conversation" }).click();
    await kasia.getByRole("button", { name: "Join now" }).click({ timeout: 30_000 });
    await expect(people(kasia)).toContainText("Ian", { timeout: 45_000 });
    await expect(people(ian)).toContainText("Kasia", { timeout: 45_000 });
    console.log("private conversation: both moved and see each other");

    // Kasia returns to the main table with one tap.
    await kasia.getByRole("button", { name: "Conversations" }).first().click();
    await kasia.getByRole("button", { name: "Leave & return to main" }).click();
    await expect(people(kasia)).not.toContainText("Ian", { timeout: 45_000 });
    console.log("Kasia back in main; Ian (still in Outside) no longer visible to her");

    expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
  } finally {
    const status = await ian.evaluate(async (g) => (await fetch(`/api/gatherings/${g}/end`, { method: "POST" })).status, gid);
    // Both were remembered (the default): forget them, which also deletes the saved table.
    const forget = (p: Page) => p.evaluate(async () => (await fetch("/api/me", { method: "DELETE", body: JSON.stringify({ everything: true }) })).status);
    console.log(`gathering ended: HTTP ${status}; profiles forgotten: ${await forget(ian)}, ${await forget(kasia)}`);
  }
});

/**
 * Screenshot tour of every screen at real phone sizes, plus the "remembered"
 * flow end to end: start a saved table, a guest joins by its link and is
 * remembered, both go home and come back with one tap. Silent fake
 * microphones, so no translation is billed. Every profile and table it
 * creates is deleted at the end ("Forget me").
 *
 *   E2E_BASE_URL=<url> pnpm exec playwright test -c playwright.prod.config.ts screens
 *   SCREEN_SIZES=360x740,390x844  SCREEN_CROWD=1 (adds three more people at the first size)
 *
 * Screens land in test-results/screens/<width>x<height>/.
 */
import path from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const SILENT_WAV = path.resolve(__dirname, "..", "e2e", "fixtures", "silence_30s.wav");
const OUT = path.resolve(__dirname, "..", "..", "test-results", "screens");
const SIZES = (process.env.SCREEN_SIZES ?? "360x740,390x844")
  .split(",")
  .map((s) => s.split("x").map(Number) as [number, number]);
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

let browser: Browser;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${SILENT_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
});

async function phone(width: number, height: number): Promise<Page> {
  const ctx = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}

/** No sideways scrolling allowed on any screen. */
async function noOverflow(page: Page, where: string) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed") {
        bad.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 80));
      }
    }
    return { scroll: document.documentElement.scrollWidth - w, bad: bad.slice(0, 5) };
  });
  expect(over.scroll, `${where}: page wider than the screen`).toBeLessThanOrEqual(0);
  expect(over.bad, `${where}: elements sticking out`).toEqual([]);
}

async function forget(page: Page) {
  return page.evaluate(async () => (await fetch("/api/me", { method: "DELETE", body: JSON.stringify({ everything: true }) })).status);
}

for (const [w, h] of SIZES) {
  test(`screens at ${w}x${h}`, async () => {
    test.setTimeout(300_000);
    const dir = path.join(OUT, `${w}x${h}`);
    let n = 0;
    const shot = async (page: Page, name: string, fullPage = false) => {
      n += 1;
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(dir, `${String(n).padStart(2, "0")}-${name}.png`), fullPage });
      await noOverflow(page, name);
    };
    const people: Page[] = [];

    const host = await phone(w, h);
    people.push(host);
    let gid = "";
    try {
      // First visit: welcome, then start a saved table.
      await host.goto("/");
      await host.getByRole("button", { name: "Start a table" }).waitFor();
      await shot(host, "welcome", true);
      await host.getByRole("button", { name: "Start a table" }).click();
      await host.getByPlaceholder("Sunday dinner").fill("Screens table");
      await host.getByPlaceholder("Ian").fill("Ian");
      await host.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: "Español" }).click();
      await host.getByRole("group", { name: "Language I want to hear" }).getByRole("button", { name: "Español" }).click();
      await host.getByRole("checkbox", { name: /I am an adult/ }).check();
      await expect(host.getByRole("checkbox", { name: /Remember me/ })).toBeChecked();
      await shot(host, "create", true);
      await host.getByRole("button", { name: "Create & get invite" }).click();
      await host.waitForURL(/\/g\/[0-9a-f-]{36}/);
      gid = new URL(host.url()).pathname.split("/")[2];
      await host.locator(".link-box").waitFor();
      await shot(host, "invite-sheet");
      const link = (await host.locator(".link-box").textContent())!.trim();
      expect(link).toMatch(/\/t\/[0-9a-f-]{36}\/join#k=/);
      await host.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      await shot(host, "room-alone");

      // A guest opens the table link and is remembered.
      const guest = await phone(w, h);
      people.push(guest);
      await guest.goto(link);
      await guest.getByPlaceholder("Kasia").waitFor();
      await shot(guest, "join-1", true);
      await guest.getByPlaceholder("Kasia").fill("Kasia");
      await guest.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: "Polski" }).click();
      await guest.getByRole("group", { name: "Language I want to hear" }).getByRole("button", { name: "Polski" }).click();
      await guest.getByRole("button", { name: "Continue" }).click();
      await guest.getByRole("button", { name: /Check my headset/ }).click();
      await guest.getByLabel("Microphone level").waitFor();
      await shot(guest, "join-2-headset", true);
      await guest.getByRole("button", { name: "Continue" }).click();
      await guest.getByRole("checkbox", { name: /I am an adult/ }).check();
      await shot(guest, "join-3", true);
      await guest.getByRole("button", { name: "Join the table" }).click();
      await guest.waitForURL(new RegExp(`/g/${gid}$`));
      await guest.getByRole("region", { name: "People in this conversation" }).getByText("Ian").waitFor({ timeout: 45_000 });
      await shot(guest, "room-two");
      await guest.getByRole("button", { name: "Turn on microphone" }).click();
      await shot(guest, "room-mic-on");
      await guest.getByRole("region", { name: "People in this conversation" }).getByText("Ian").click();
      await shot(guest, "speaker-sheet");
      await guest.keyboard.press("Escape");
      await guest.getByRole("navigation", { name: "Controls" }).getByRole("button", { name: "Conversations" }).click();
      await shot(guest, "conversations-sheet");
      await guest.keyboard.press("Escape");
      await guest.getByRole("button", { name: "Settings" }).click();
      await shot(guest, "settings-sheet");
      await guest.getByRole("button", { name: /Start pocket mode/ }).scrollIntoViewIfNeeded();
      await shot(guest, "settings-pocket");
      await guest.getByRole("button", { name: /Start pocket mode/ }).click();
      await guest.getByRole("dialog", { name: "Pocket mode" }).waitFor();
      await shot(guest, "pocket-mode");
      await guest.keyboard.press("Escape");
      await expect(guest.getByRole("dialog", { name: "Pocket mode" })).toHaveCount(0);

      if (process.env.SCREEN_CROWD === "1" && w === SIZES[0][0]) {
        for (const [name, lang] of [
          ["Marta", "English"],
          ["Ewa", "Polski"],
          ["Diego", "Español"],
        ] as const) {
          const p = await phone(w, h);
          people.push(p);
          await p.goto(link);
          await p.getByPlaceholder("Kasia").fill(name);
          await p.getByRole("group", { name: "Language I speak" }).getByRole("button", { name: lang }).click();
          await p.getByRole("button", { name: "Continue" }).click();
          await p.getByRole("button", { name: "Continue" }).click();
          await p.getByRole("checkbox", { name: /I am an adult/ }).check();
          await p.getByRole("checkbox", { name: /Remember me/ }).uncheck();
          await p.getByRole("button", { name: "Join the table" }).click();
          await p.waitForURL(new RegExp(`/g/${gid}$`));
        }
        await host.getByRole("region", { name: "People in this conversation" }).getByText("Diego").waitFor({ timeout: 45_000 });
        await shot(host, "room-five-people");
      }

      // Both go home: the table is saved with who's there; one tap brings them back.
      await host.goto("/");
      await host.getByRole("region", { name: "Your tables" }).getByText("Screens table").waitFor();
      await shot(host, "home-tables", true);
      await host.getByRole("button", { name: "Manage Screens table" }).click();
      await shot(host, "table-sheet");
      await host.keyboard.press("Escape");
      await host.getByRole("button", { name: "My name and languages" }).click();
      await shot(host, "profile-sheet");
      await host.keyboard.press("Escape");
      await host.getByRole("button", { name: "New table" }).click();
      await shot(host, "new-table-sheet");
      await host.keyboard.press("Escape");

      await guest.goto("/");
      await guest.getByRole("region", { name: "Your tables" }).getByText("Screens table").waitFor();
      await shot(guest, "guest-home");
      await guest.getByRole("button", { name: /(Join|Open) Screens table/ }).click();
      await guest.waitForURL(new RegExp(`/g/${gid}$`));
      await guest.getByRole("region", { name: "People in this conversation" }).waitFor();
      await shot(guest, "guest-back-in-one-tap");
      expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
    } finally {
      if (gid) await host.evaluate(async (g) => (await fetch(`/api/gatherings/${g}/end`, { method: "POST" })).status, gid).catch(() => 0);
      const forgotten = await Promise.all(people.map((p) => forget(p).catch(() => 0)));
      console.log(`${w}x${h}: ${n} screens in ${dir}; gathering ${gid ? "ended" : "not created"}; profiles forgotten: ${forgotten.join(",")}`);
      await Promise.all(people.map((p) => p.context().close()));
    }
  });
}

import { defineConfig } from "@playwright/test";

/**
 * Walk-through of the DEPLOYED app with two fake-mic Chrome "phones"
 * (tests/e2e-prod). Uses real LiveKit Cloud, the deployed worker and the real
 * provider, so it costs a little; run it on purpose, not in CI.
 */
export default defineConfig({
  testDir: "tests/e2e-prod",
  outputDir: "test-results/playwright-prod",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://eight-person-live-translator.vercel.app",
    trace: "retain-on-failure",
  },
});

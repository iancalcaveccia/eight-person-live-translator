import { defineConfig } from "@playwright/test";

/**
 * Browser E2E against a locally running stack (see scripts/e2e-local.ps1):
 * livekit-server --dev, the Python worker with TRANSLATION_PROVIDER=mock,
 * and a production build of the web app with NEXT_PUBLIC_E2E_HOOKS=1.
 * Uses the installed Chrome with fake microphones fed from WAV fixtures.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-report.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
});

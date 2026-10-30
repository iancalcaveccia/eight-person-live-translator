# START HERE — Eight-person streaming interpreter (Codex handoff)

**Package status:** COMPLETE BUILD DOCUMENTATION, NOT AN IMPLEMENTED OR LIVE APPLICATION. The project does not magically deploy after uploading these docs. The existing upstream starter is an actual working reference app, while all custom features in this pack require engineering and real phone tests.

## Your personal build checklist

### Accounts (one developer account per platform — guests do NOT need subscriptions)

1. GitHub: account/repository to hold code. You already connected GitHub to ChatGPT; Codex may require selecting/authorizing it separately. Open https://github.com/livekit-examples/gemini-live-translate and click **Fork**, or use GitHub's template/import features according to repository options. Suggested fork name: `eight-person-live-translator`.
2. Codex: https://chatgpt.com/codex — select your fork as the working repository or open a local folder with Codex CLI. Give Codex access to this documentation, ideally by extracting its contents into your fork's `docs/` folder. Paste `01_MASTER_CODEX_PROMPT.md` as the first task. Tell it to implement **M0 and M1 immediately**, not just generate another plan.
3. LiveKit Cloud: https://cloud.livekit.io — create a project, obtain LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET; configure secrets securely.
4. Google AI Studio: https://aistudio.google.com — enable paid API if required, create `GEMINI_API_KEY` and set billing alerts. Validate `gemini-3.5-live-translate-preview` availability and current pricing.
5. Vercel: https://vercel.com — connect GitHub fork; deploy Next.js frontend there, after Codex has built a secure token endpoint.
6. Managed Postgres, e.g. Neon or Supabase — for authorized gatherings, invitations and breakout membership. Select after reviewing M4 data model. Keep DB connection URL server-side.
7. Optional: https://platform.openai.com — `OPENAI_API_KEY` for second model experiments. NOT required to launch the first Gemini MVP.

### Do NOT expose keys

API keys belong in LiveKit/Vercel server secrets or ignored `.env.local` files. Never paste them into a public repo, shareable screenshots, the browser UI or Codex prompts. Use placeholders.

### Local test and deployment sequence

1. Fork upstream source; inspect MIT license and README.
2. In a local clone: `pnpm run setup` at project root; fill the upstream `.env.local` placeholders and `translator/.env.local` *locally*; run `pnpm run dev` (current upstream documented command; recheck after code changes).
3. Test existing 2-person demo with two actual devices and working headsets. That baseline is NOT yet a test of your desired custom features.
4. In Codex: include this package in the repo, execute the master task and implement milestone M1. Review tests, code and visible realtime behavior.
5. Add stages M2–M4, including breakout privacy and natural interruptions. Deploy frontend on Vercel and agent on LiveKit Cloud when ready.
6. Do real phone tests under Wi-Fi and cell data before inviting eight people. Native mobile wrappers are an option if the browser cannot continue microphone/audio reliably with the screen locked.

## Absolute top requirements

- Eight total humans, each with independent phone + Bluetooth headset, speaking EN, PL or ES.
- Spanish preferences: Argentina, Colombia, Spain; these are preferences, NOT guarantees of accent-specific model output.
- Audio translation **starts before the source speaker finishes**, with fast but nonzero rolling lag.
- Natural interruptions: multi-speaker concurrent translations; no force-stop/press-to-talk global floor.
- Each source has distinct labeled translated tracks; model voice quality/identity best-effort; optional explicit opt-in cloning later.
- Private breakout subgroups that actually isolate audio/captions server-side, while sharing parent gathering presence.
- Transparent monitoring, cost caps, no secret leakage, no default recordings.

## Files and recommended reading order

1. `01_MASTER_CODEX_PROMPT.md` — the one message to paste into Codex.
2. `02_PRODUCT_REQUIREMENTS.md` — experience and languages.
3. `03_TECHNICAL_ARCHITECTURE.md` — LiveKit/Gemini/Next.js and media topology.
4. `04_STREAMING_LATENCY_SPEC.md` — simultaneous interpretation release gate.
5. `05_INTERRUPTS_AND_OVERLAP.md` — natural speech overlaps and ducking.
6. `06_BREAKOUT_PRIVACY_SPEC.md` — separate authorized media rooms and group privacy.
7. `07_SPEAKER_VOICES.md` — voice identity, cloning and consent.
8. `08_MOBILE_AND_BLUETOOTH.md` — mobile realities and headset testing.
9. `09_TEST_MATRIX.md` — tests inherited from previous project brief.
10. `10_DEPLOYMENT_AND_ENV.md` — exact hosting responsibilities and variable checklist.
11. `11_SECURITY_COST_AND_OBSERVABILITY.md` — trusted server rules, spending limits, metrics.
12. `12_MILESTONES_AND_REPORTING.md` — how Codex proves it has really built things.
13. `13_REPO_HANDOFF.md` — Codex task and GitHub instructions.
14. `14_OFFICIAL_REFERENCES.md` — docs and verified model restrictions.
15. `AGENTS.md` — repository-wide instructions for AI coding agents.
16. `ENV_EXAMPLE_FRONTEND.env` and `ENV_EXAMPLE_WORKER.env` — sample placeholders, not actual secrets.

The upstream quickstart is `https://github.com/livekit-examples/gemini-live-translate` and under MIT license. Respect its source as the implementation baseline.

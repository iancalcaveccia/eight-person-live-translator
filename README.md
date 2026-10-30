# Mesa — live interpreter for an eight-person table

Up to eight people, each with their own phone and Bluetooth headset, talk
naturally in **English, Polish or Spanish** (Argentine / Colombian / Castilian
preference) and hear everyone else **interpreted live into their own language,
while the speaker is still talking**. People can interrupt each other, and the
table can split into **private conversations** (living room / outside) and come
back together.

Built on the MIT-licensed [livekit-examples/gemini-live-translate](https://github.com/livekit-examples/gemini-live-translate)
(Next.js + LiveKit + a Python LiveKit Agents worker), extended with secure
gatherings, breakout groups, a listener-side interruption mixer, cost controls,
a mobile UI and a provider abstraction (Gemini primary, OpenAI backup).

> **Status (2026-10-30):** all automated tests pass locally, including real
> Chrome + LiveKit + worker end-to-end runs with a mock translator (see
> [docs/TEST_REPORT.md](docs/TEST_REPORT.md)). The web app is deployed at
> https://eight-person-live-translator.vercel.app but is **not functional
> until the database, LiveKit and Gemini credentials are configured**
> ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). Real-provider latency and every
> real-phone / Bluetooth test are **not yet run**.

## How it works (short)

- **Gathering** = invite-only container (link/QR, host access code to create).
- **Conversation group** = its own LiveKit room. You are in exactly one at a
  time; the server picks the room for your token, evicts you from the old room
  when you switch, and the worker re-checks every participant against Postgres.
- **Translation** = one streaming session per *(speaker, target language)* per
  group, shared by all listeners of that language, published as track
  `tx:<speaker>:<lang>`. Same-language listeners hear the original voice.
- **Listening** = each phone mixes the incoming tracks in Web Audio: short
  interjections duck the longer speaker by ~7 dB instead of muting; Focus and
  Equal modes; per-speaker volume, mute, "hear original".

Details: [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md),
interface contract: [docs/architecture/CONTRACT.md](docs/architecture/CONTRACT.md),
worker design: [docs/architecture/WORKER.md](docs/architecture/WORKER.md).

## Repository layout

```
src/app/            Next.js App Router pages + API route handlers
src/server/         control plane: Postgres, auth, groups, tokens, caps (server-only)
src/client/         browser media: MediaSession, mixer, routing, captions, latency
src/components/     UI (room screen, sheets, onboarding)
translator/         Python LiveKit Agents worker (Gemini / OpenAI / mock providers)
tests/unit/         vitest: authorization, privacy partitions, mixer, routing
tests/e2e/          Playwright: real Chrome + local LiveKit + worker (mock provider)
docs/               specs (docs/codex), architecture, providers, mobile, costs, test report
scripts/            e2e-local.ps1, configure-cloud.ps1, setup.sh
```

## Run locally

Requirements: Node 20+, pnpm 10, Python 3.11–3.13 with [uv](https://docs.astral.sh/uv/).

```bash
pnpm run setup            # installs both halves, creates .env.local files
```

**Without any cloud account** (mock translator, local LiveKit server):

1. Download `livekit-server` from the official [releases](https://github.com/livekit/livekit/releases) and run `livekit-server --dev`.
2. `.env.local`: `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`, `INTERNAL_API_SECRET=dev-secret`, `HOST_ACCESS_CODE=dev`.
3. `translator/.env.local`: same LiveKit values, `TRANSLATION_PROVIDER=mock`, `CONTROL_PLANE_URL=http://localhost:3000`, `INTERNAL_API_SECRET=dev-secret`.
4. `pnpm run dev` and open http://localhost:3000 (the embedded dev database lives in `./.data`).

**With real translation:** use your LiveKit Cloud project values and set
`GEMINI_API_KEY` (and optionally `OPENAI_API_KEY`) in `translator/.env.local`,
with `TRANSLATION_PROVIDER=gemini`.

## Tests

```bash
pnpm test                                   # vitest unit/integration (control plane, mixer, routing)
pnpm lint && pnpm typecheck && pnpm build
cd translator && uv run pytest && uv run ruff check && uv run ruff format --check
pwsh scripts/e2e-local.ps1                  # browsers + LiveKit + worker (mock), Windows script
```

## Deploy

- **Web** → Vercel (project linked to this repo, region `fra1`, daily cleanup cron).
- **Worker** → LiveKit Cloud Agents, region `eu-central` (Frankfurt).
- **Database** → managed Postgres (Neon via Vercel Marketplace recommended).

Run `powershell -ExecutionPolicy Bypass -File scripts\configure-cloud.ps1 -AppUrl https://<app>.vercel.app` after
`lk cloud auth`. It asks for the Gemini key (masked) if `translator/.env.local` lacks it, sets every secret on
Vercel and LiveKit without exposing values, deploys both halves and checks
`/api/health`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Important limits (honest)

- Polish can only be produced by Gemini; OpenAI's translation model has no Polish output. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- Spanish regional preference is shown and recorded but no live model can produce a specific regional accent yet.
- Voices: the models adapt to each speaker's voice on their own; there is no voice picker and no cloning.
- iPhone pauses the microphone when the screen locks; the app keeps the screen awake. See [docs/MOBILE.md](docs/MOBILE.md).
- Server-side group privacy cannot stop a microphone from physically hearing someone nearby.
- Costs: see [docs/COSTS.md](docs/COSTS.md) (≈ $5–6 per hour for an active 8-person, 3-language table on Gemini; hard caps enforced).

## License

MIT, including the upstream LiveKit example (see [LICENSE](LICENSE)).

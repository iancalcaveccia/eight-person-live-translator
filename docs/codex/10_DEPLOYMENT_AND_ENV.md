# Deployment and environment: Vercel + LiveKit Cloud + Google Gemini

**Status:** instructions, not a claim of existing deployment. Application must be built and tested first.

## Three service roles

| Component | Provider | Purpose | Deployment |
|---|---|---|---|
| Next.js frontend and secure small HTTP APIs | Vercel | Website/PWA, gatherings, invite and group management, member auth, room token minting | Import GitHub fork as Vercel project |
| WebRTC SFU media rooms | LiveKit Cloud | Bidirectional low-latency audio transport and per-group authorized media routing | Create LiveKit project |
| Long-running Python translation worker | LiveKit Cloud Agents | Subscribe to source mic tracks; stream PCM to Gemini/OpenAI; publish speaker-labeled translated audio | LiveKit agent deployment / Python container |
| AI streaming speech-to-speech | Google Gemini API | Translate as original speaker continues; generate speech and captions | Google API account and server-only key |
| Authoritative group membership store | Managed Postgres | Secure gatherings, group invitations, epochs, memberships, join limits, spending policies | Managed provider + server-only URL |
| Optional second translator | OpenAI API | `gpt-realtime-translate` comparative fallback | Server-only key, isolated integration |

## Baseline upstream local setup (before custom refactor)

Current reference docs at `https://github.com/livekit-examples/gemini-live-translate` say:

```bash
# Tools: Node.js 20+, pnpm, Python 3.11+, uv
pnpm run setup
# fill root .env.local and translator/.env.local LOCALLY
pnpm run dev
# open http://localhost:3000
```

Required upstream secrets are `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in both frontend and agent, `GEMINI_API_KEY` in agent only. Do not pretend placeholder files or sample data enable real translation. The refactor adds DB/securing/policy variables below; adapt to real code.

## LiveKit Cloud worker deploy

Use the actual current LiveKit CLI (recheck before running):

```bash
cd translator
lk agent create --secrets-file .env.local .  # first agent deployment
lk agent deploy                            # subsequent deployments
```

Never commit `translator/.env.local`. Agent must have private `GEMINI_API_KEY`. Check real logs, worker registration and capacity. Select region near Kraków when available (e.g. EU Central/Frankfurt) but verify cloud and AI provider processing geography; one region choice doesn't promise EU-only processing. Use separate staging and production agents/projects.

## Vercel frontend deployment

1. Import the user's GitHub **fork** and choose correct root directory for Next.js (normally root; check modified layout).
2. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` as **server environment variables** (not `NEXT_PUBLIC_...`). If using DB, add `DATABASE_URL` as server-only secret.
3. Configure staging/production domain and HTTPS. Check `NEXT_PUBLIC_APP_URL` (public URL, no secrets) and allowed CORS/origins.
4. Deploy, then verify a real test request to the room token API: uninvited access must be rejected; invited users receive short-lived room-scoped grants.
5. Connect two physical devices and test real microphone routing, not only page rendering. Monitor agent logs and translation output.
6. Test preview branch and staged rollbacks. Never leak provider keys through edge/API errors, logs or browser inspector.

**Do not put the Python worker in Vercel serverless functions.** Keep long-lived realtime connections on LiveKit Cloud Agents.

## Environment variables

Refer to `ENV_EXAMPLE_FRONTEND.env` / `ENV_EXAMPLE_WORKER.env` in this package. They document **illustrative** variables; exact names are resolved against code during implementation. The current upstream frontend env names must be preserved or upgraded carefully. Optional OpenAI features remain disabled if key absent.

## Production release gate

- No vulnerable unauthenticated token endpoint or arbitrary join to other group's LiveKit room.
- Staging Vercel URL and worker exist and are tested; no placeholder mock audio.
- At least two people on different real phones can hear translating WHILE speaker is still talking.
- Interruptions tested on hardware; test 8 physical devices or mark it NOT TESTED.
- DB migrations, secret storage, log redaction, backups and rate limiting enabled.
- Translation budget and alerts on; no indefinite paid sessions after mute/switch/disconnect.
- Group switches forcibly disconnect the old room; server controls active group epoch and token validity.
- Known Safari/Android limitations visible in UX/readme.

## Your next steps in Codex

1. Make fork.
2. Add docs into fork.
3. Paste master prompt, ask Codex to start coding immediately.
4. Run local smoke tests with two phones.
5. Deploy LiveKit worker; deploy Next.js to Vercel.
6. Read actual staging link and test with people; then expand.

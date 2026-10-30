# Test report

```text
STATUS: CODE WORKS LOCALLY (mock translator, local LiveKit) — PARTIAL overall
Milestones: M0 done; M1–M5 implemented and tested locally with a mock provider;
            real-provider, real-phone and deployment items blocked on credentials/devices
Translation provider + model id: gemini-3.5-live-translate-preview (primary),
            gpt-realtime-translate (backup, en/es targets only); NOT exercised with real keys
Real-device tests: NOT PERFORMED
Live URL: see "Deployment" below
```

Environment: Windows 11, 14 logical CPUs, 15.5 GB RAM; Node 25.9, pnpm
10.18.0, Python 3.13.18 (uv 0.13.6); livekit-server 1.13.10 (`--dev`, local);
Chrome 156 (headless, fake microphone from WAV files). Date: 2026-10-30.

## 1. Baseline (M0) — upstream before changes

| Check | Result |
|---|---|
| `pnpm install`, `pnpm build` | PASS |
| `pnpm lint` | FAIL — 3 pre-existing `react-hooks/set-state-in-effect` errors (files later rewritten) |
| `uv run pytest` | PASS — 11 tests |
| `uv run ruff check` | FAIL — 4 pre-existing errors in `tests/test_router.py` (fixed) |
| Security review of upstream | open `/api/token` minted tokens for any room/identity; no invites, groups, consent, caps (all replaced) |

## 2. Automated tests on this branch

| Suite | Command | Result |
|---|---|---|
| Web unit/integration (vitest, real Postgres via PGlite, real route handlers, real JWTs) | `pnpm test` | **59 passed** |
| Type-check | `pnpm typecheck` | PASS |
| Lint | `pnpm lint` | PASS |
| Production build | `pnpm build` | PASS |
| Secret names in client bundle (`.next/static`) | grep for 9 secret names + server code markers | **0 matches** |
| Worker unit tests | `cd translator && uv run pytest` | **98 passed**, 2 skipped (integration) |
| Worker lint/format | `uv run ruff check . && uv run ruff format --check .` | PASS |
| Worker LiveKit integration (real WebRTC, local server, mock provider) | `LIVEKIT_INTEGRATION=1 uv run pytest tests/integration -s` | **2 passed** |
| Browser E2E (real Chrome × N, local LiveKit, real worker, mock provider) | `pwsh scripts/e2e-local.ps1` | see section 4 |

Mutation check: disabling the server's "not in this group" admission rule
makes 5 privacy tests fail (move/replay + all four partitions), so they are
not vacuous.

### What the web tests cover

- Host access code, consent required, invite validation (wrong token and
  unknown gathering are indistinguishable), 8-human cap, invite rotation,
  cross-origin rejection, per-IP rate limit.
- Media token grants: room = caller's current group only, `canPublishData=false`,
  `canUpdateOwnMetadata=false`, microphone-only publishing, no room admin,
  10-minute TTL, agent dispatch metadata, `maxParticipants=10` (8 humans + agent
  + reconnect slack — upstream's 8 would have rejected the 8th human or the agent).
- Private groups: names/members hidden from non-members; non-members cannot
  enter (same 404 as a non-existent group); moving evicts the old room and
  bumps the epoch; an old token's identity fails admission (replay); invitation
  accept/decline; owner-only removal moves the person to main and evicts;
  empty groups close, rooms are deleted, pending invitations revoked.
- Partitions **5+3, 4+4, 3+3+2, 2+2+2+2**: every participant's token points to
  their own room and admission for each room allows exactly its members.
- Concurrent moves leave exactly one active group with a newer epoch.
- Host kick (session + admission revoked), guests can't use host controls,
  ending a gathering deletes names and keeps only anonymous usage.
- Signed worker API: test vector shared with Python, bad/stale signatures
  rejected, unknown room 404, usage pricing, gathering cap and monthly cap stop
  translation, absurd values clamped.
- Mixer policy: interjection ducks the monologue by 7 dB (never mutes),
  two-voice foreground with ≥ 3 talkers, focus/equal modes, smoothing,
  activity hysteresis. Routing: never native + translated for the same speaker,
  auto-detect speakers, "hear original", comparison tracks.

## 3. Pipeline latency with the mock translator (worker integration test)

The mock returns the input audio after a fixed delay, so these numbers
measure **our pipeline**, not Gemini.

| Scenario | Mock delay | First translated audio at listener | Before speaker finished? |
|---|---|---|---|
| 22 s es→pl monologue | 0 ms | 0.22 s (pipeline overhead) | yes |
| 22 s es→pl monologue | 1200 ms | 1.41–1.42 s; end catch-up 1.42 s | yes, ~100 % of translatable speech |
| 1.5 s pl interjection at 8 s during monologue | 1200 ms | 1.41–1.42 s after interjection onset | yes, main speaker still talking |

## 4. Browser end-to-end (real Chrome, local stack, mock translator)

_Filled in from `test-results/e2e-metrics.json` after the run._

## 5. Not run (needs your keys or devices)

| Item | Why not | How to run |
|---|---|---|
| Real Gemini / OpenAI translation, real first-audio latency p50/p95 per language pair | no API keys in this environment | `translator/scripts/latency_probe.py` after `configure-cloud.ps1` |
| Provider A/B (accuracy, accents, names/numbers, voice consistency) | keys + bilingual reviewers | `PROVIDER_COMPARE=true`, see `docs/PROVIDERS.md` |
| Every phone / Bluetooth / screen-lock / network-switch test | no phones attached | `docs/DEVICE_TEST_PLAN.md` |
| 8 physical devices in one room, acoustic bleed | devices + people | same |
| Krisp noise / voice-focus filter | requires LiveKit Cloud | toggle in Settings once deployed |

## 6. Deployment

_Filled in after the deployment step._

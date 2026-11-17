# Test report

```text
STATUS: DEPLOYED; REAL GEMINI TRANSLATION VERIFIED END-TO-END THROUGH THE LIVE APP
        (synthetic participants) — phone/Bluetooth tests NOT PERFORMED
Milestones: M0–M5 implemented; tested locally (mock) and in production (real Gemini)
Translation provider + model id: gemini-3.5-live-translate-preview (primary, configured);
            gpt-realtime-translate (backup, en/es only) — NOT configured, NOT exercised
Real-device tests: NOT PERFORMED (needs two phones; docs/DEVICE_TEST_PLAN.md)
Live URL: https://eight-person-live-translator.vercel.app (verified 2026-11-17, section 6)
```

Environment: Windows 11, 14 logical CPUs, 15.5 GB RAM; Node 25.9, pnpm
10.18.0, Python 3.13.18 (uv 0.13.6; worker suite re-run on 3.12.10 on
2026-11-17 after uv's managed Python was removed from the machine);
livekit-server 1.13.10 (`--dev`, local); Chrome 156 (headless, fake
microphone from WAV files). Dates: 2026-10-30 (local), 2026-11-17 (production).

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
| Web unit/integration (vitest, real Postgres via PGlite, real route handlers, real JWTs) | `pnpm test` | **63 passed** |
| Type-check | `pnpm typecheck` | PASS |
| Lint | `pnpm lint` | PASS |
| Production build | `pnpm build` | PASS |
| Secret names in client bundle (`.next/static`) | grep for 9 secret names + server code markers | **0 matches** |
| Worker unit tests | `cd translator && uv run pytest` | **100 passed**, 2 skipped (integration) — incl. 2 keepalive tests added 2026-11-17 |
| Worker lint/format | `uv run ruff check . && uv run ruff format --check .` | PASS |
| Worker LiveKit integration (real WebRTC, local server, mock provider) | `LIVEKIT_INTEGRATION=1 uv run pytest tests/integration -s` | **2 passed** |
| Browser E2E (real Chrome, local LiveKit, real worker, mock provider) | `pwsh scripts/e2e-local.ps1` | **4 passed** (section 4) |

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

`pwsh scripts/e2e-local.ps1` starts livekit-server `--dev`, the real worker
(`TRANSLATION_PROVIDER=mock`, 1.2 s delayed passthrough), a production build of
the web app, and drives **real headless Chrome** whose microphones play WAV
files (synthetic English TTS — content is irrelevant to the mock). Everything
runs on one laptop, so CPU is saturated during the 8-person test; timings are
pessimistic and are **not** phone or real-provider numbers.

Final clean run (2026-10-30 12:23 UTC): **4 / 4 passed** in 175 s; the
strengthened 8-person test was re-run on its own and passed again.

| Test | Result | Measured |
|---|---|---|
| 30 s Spanish monologue → Polish listener: translated audio starts while the speaker is still talking; listener receives `tx:<speaker>:pl` and **not** the speaker's own mic | PASS | first audible translation 3.3 s / 5.7 s after mic-on in two runs (includes fake-mic start + 1.2 s mock delay); worker-onset→audible p50 1.46–1.50 s, p95 2.0–4.1 s |
| Interruption: main speaker 34 s monologue, second person says "What? Seriously?" at 8 s, third person listens | PASS | main speaker hears the translated interjection at 11.2–11.3 s from mic-on (monologue still running, mic still live); third listener's mix: monologue ducked to gain 0.65 (on its way to 0.45), interjection 1.0 |
| Private group: 3 people, host starts "Outside" with one guest | PASS | switch 4.1–4.5 s; outsider sees no name/members, gets 404 entering by id, receives no tracks; **old main-room token replayed from Python** → evicted by the worker after 0.7–1.8 s (`PARTICIPANT_REMOVED`); guest returns to main with one tap |
| 8 people (ES/PL/EN) in one gathering, split 5 + 3 | PASS | 2 rooms, one interpreter job each; positive control (translation flowing in both groups) then **no participant subscribed to anyone from the other group** |

Issues found and fixed by these runs: embedded DB failed on a fresh checkout
(nested data dir); Playwright hung on Windows by deleting its output folder
while server logs inside it were open; the worker refused new rooms when the
shared laptop CPU was saturated (`AGENT_IGNORE_HOST_LOAD=1` for local rigs only;
LiveKit Cloud ignores custom load functions); a React hydration mismatch on the
join page; and the room now says "Interpreter unavailable" if no interpreter
joins within 25 s instead of "Starting…" forever.

Not covered by E2E: real Gemini/OpenAI, phones, Bluetooth, mobile networks,
iOS Safari (headless Chrome only), Krisp filters (need LiveKit Cloud).

## 5. Real Gemini through the deployed app (2026-11-17)

`translator/scripts/latency_probe.py --app-url https://eight-person-live-translator.vercel.app`
behaves like two phones: it creates a gathering with the host code, joins a
second participant through the invite link, gets both media tokens **from the
production API**, publishes a WAV clip as the speaker's microphone in real
time and listens to the translated track. So the real control plane, Neon
Postgres, admission check, LiveKit Cloud (eu-central) and the deployed worker
with real Gemini are all in the path. The gathering is ended afterwards (data
deleted). Raw results: `docs/results/2026-11-17-*.json`.

"First audio" = speaker's speech onset → first audible translated speech at the
listener (> −45 dBFS), on the same clock. Repetitions the overloaded test
laptop could not publish in real time (wall time > 1.1 × audio time) are
excluded from p50/p95 and marked in the JSON.

| Pair (source clip) | Reps used | First audio p50 / p95 | Began before speaker finished | Translated speech heard before speaker finished | Catch-up after speaker stopped |
|---|---|---|---|---|---|
| en → es (33 s, Windows TTS) | 1 of 3 | 4.20 s (excluded reps: 3.56, 5.25 s) | yes, all | 23 s of 25 s speech (used rep) | 4.7 s (used rep) |
| en → pl (33 s) **+ en "What? Seriously?" at 8 s → es** | 3 of 3 | 3.66 s / 3.85 s; interjection 3.78 s / 4.16 s | yes, all; interjection heard while main speech still running, all | 23–24 s of 25 s speech | 3.6–3.7 s |
| es → pl (50 s, Gemini's own Spanish output) | 2 of 2 | 3.30 s / 3.31 s | yes, all | ~28 s of 30 s speech | 3.0–3.2 s |
| pl → en (34 s, Gemini's own Polish output) | 2 of 2 | 3.70 s / 4.04 s | yes, all | 23–24 s of 27 s speech | 2.8–2.9 s |
| es → en (50 s, Gemini's own Spanish output) | 2 of 2 | 3.20 s / 3.27 s | yes, all | ~27 s of 30 s speech | 2.4–2.8 s |

Reading: a listener hears the translation **about 3.2–4.2 s after the speaker
starts** (p50 per pair), it keeps flowing while they talk (release gate 2:
streaming, not end-of-turn), and it finishes about 3 s after they stop. Most
of that is the model: the worker's own onset → first Gemini audio figures for
the main speech were 1.9–3.8 s (the JSON also holds a few sub-second values
from the other participant's session, which the probe does not label). An
interjection is translated independently while the long speech continues
(release gate 3).

Found and fixed with the real service: Gemini closes a stream after exactly
**120 s without input** ("1008 Session closed due to client inactivity").
Because the worker withholds silence to save cost, every quiet participant's
stream was dropping and reopening every two minutes (seen in the first run as
`reconnecting` states). Measured directly: a 100 ms silent chunk every 25 s
kept a stream open past 240 s. The worker now sends one after 30 s without
input (`STREAM_KEEPALIVE_SEC`); after redeploying, no run showed a reconnect.

Limits of these numbers: synthetic voices (English from Windows TTS; Spanish
and Polish sources are Gemini's own synthesized output, which is clean
studio-like speech), one desktop on home internet as both "phones", no
Bluetooth (adds its own buffering), no accuracy or voice-similarity scoring.
Estimated provider cost of all testing on 2026-11-17, from the worker's price
table: well under $1.

## 6. Not run (needs your devices or reviewers)

| Item | Why not | How to run |
|---|---|---|
| OpenAI backup provider | no `OPENAI_API_KEY` configured (optional) | add it to `translator/.env.local`, re-run `configure-cloud.ps1` |
| Provider A/B (accuracy, accents, names/numbers, voice consistency) | bilingual reviewers + OpenAI key | `PROVIDER_COMPARE=true`, see `docs/PROVIDERS.md` |
| Every phone / Bluetooth / screen-lock / network-switch test | no phones attached | `docs/DEVICE_TEST_PLAN.md` |
| 8 physical devices in one room, acoustic bleed | devices + people | same |
| Krisp noise / voice-focus filter | requires LiveKit Cloud | toggle in Settings once deployed |

## 7. Deployment (verified 2026-11-17)

| Piece | State | Evidence |
|---|---|---|
| Web app on Vercel `consultorios/eight-person-live-translator` | **Deployed and functional** | https://eight-person-live-translator.vercel.app, `/api/health` → `{"ok":true,"database":true,"databaseKind":"postgres","livekit":true,"internalApi":true,"hostCode":true,"commit":"64c86b9"}`; `/api/config` → `mediaConfigured:true, maxHumans:8, defaultProvider:gemini, perGatheringCapUsd:50`; functions in `fra1` |
| Postgres | **Neon, eu-central-1**, connected via the Vercel integration | health `database:true`; gatherings created/joined/ended by the probe |
| LiveKit Cloud worker | **Running**, agent `gemini-translator` (`CA_N7EbVp9hMsHu`), region eu-central, 1 replica | `lk agent status`: version `GqpnhWHh3KoE` (keepalive fix) deployed 2026-11-17 12:46 UTC |
| Gemini key | configured on the worker only (never on Vercel, never seen by the assistant) | probe runs in section 5 |
| OpenAI key | not configured (optional backup) | — |
| Earlier live checks (2026-10-30) | PASS | landing page 200 on a phone-sized viewport; security headers (HSTS, X-Frame-Options DENY, no-referrer, mic-only Permissions-Policy); uninvited `POST /api/gatherings/<id>/token` → **401** |

Next: rows 1–6 of `docs/DEVICE_TEST_PLAN.md` on two real phones with
Bluetooth headsets. Those are the only release gates still unverified.

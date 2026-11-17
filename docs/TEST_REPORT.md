# Test report

```text
STATUS: DEPLOYED; REAL GEMINI TRANSLATION VERIFIED END-TO-END THROUGH THE LIVE APP
        (synthetic participants) + TWO INFORMAL TWO-PHONE SESSIONS BY THE OWNER (ES <-> PL)
Milestones: M0–M5 implemented; tested locally (mock) and in production (real Gemini)
Translation provider + model id: gemini-3.5-live-translate-preview (primary, configured);
            gpt-realtime-translate (backup, en/es only) — NOT configured, NOT exercised
Real-device tests: two informal sessions 2026-11-17 (sections 5c, 5d); the structured
            plan in docs/DEVICE_TEST_PLAN.md is otherwise NOT PERFORMED.
            Saved tables / home-screen install / pocket mode: tested in headless
            Chrome at phone sizes only (section 5e) — NOT on real phones
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
| Web unit/integration (vitest, real Postgres via PGlite, real route handlers, real JWTs) | `pnpm test` | **87 passed** (incl. caption retraction; 19 for remembered people & saved tables) |
| Phone-size screen tour (headless Chrome, Android UA, touch; 360×740 and 390×844) | `E2E_BASE_URL=… pnpm exec playwright test -c playwright.prod.config.ts screens` | **2 passed**, 41 screens, 0 sideways overflow (section 5e) |
| Type-check | `pnpm typecheck` | PASS |
| Lint | `pnpm lint` | PASS |
| Production build | `pnpm build` | PASS |
| Secret names in client bundle (`.next/static`) | grep for 9 secret names + server code markers | **0 matches** |
| Worker unit tests | `cd translator && uv run pytest` | **185 passed**, 2 skipped (integration) — incl. keepalive, same-room bleed, phone-offset alignment, same-language and caption-retraction tests, and 32 for the same-words (cross-talk) check added 2026-11-17 (every rule mutation-checked: removing it fails a test) |
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
- Remembered people & saved tables (`tests/unit/people.test.ts`): device cookie is
  httpOnly, 400 days, and only its SHA-256 is stored; a made-up cookie is nobody;
  consent required; only members can enter a table (non-member = same 404 as
  unknown table); a forged, old or *gathering* invite token is rejected as a table
  token, identically to an unknown table; one-time guests are seated but saved
  nowhere; contacts = only people you share a table with, and only they can be added
  to a new table; owner removal ends the person's live seat, replaces the link and
  the old link stops working; rotate/rename owner-only; leaving hands ownership on,
  last one out deletes the table; a person the host kicked cannot tap back into that
  session; seat cap enforced; re-entry takes back the same seat (no duplicates);
  host can leave a table session (hosting passes on, last one out ends it); room
  language changes are remembered; forgetting the only phone deletes the profile;
  400-day cleanup.
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

### 5a. People in the same room (live simulation, 2026-11-17)

`translator/scripts/table_sim.py` joins the deployed app as 2–3 people whose
microphones also carry each other's voices (−12 to −20 dB, 3–7 ms delay,
synthetic room reverb, −60 dBFS noise floor) and measures, on what each
person would hear: expected translations and **phantom audio** (someone's
track carrying audio while they were not talking = a neighbour's voice
translated through the wrong person). Schedule: A talks 30 s, B 30 s, A 20 s
with B's real Polish interjection "Co? Serio?" at 8 s, then both together 12 s.

| Run (real Gemini, deployed worker) | Translations heard | Phantom audio | First audio median |
|---|---|---|---|
| ES/PL couple 1 m apart, **before** the fix | 6/6 | **41.7 s** (each heard their own words back) | 2.2 s |
| ES/PL couple 1 m apart, after (4 runs) | 6/6 every run | **0.0 s every run** | 2.8–3.2 s |
| ES/PL/EN, 3 people 1 m apart, after | 8/8 | 1.9 s total (0.3–0.7 s blips, 6 tracks) | 3.2 s |
| ES/PL couple side by side (−12 dB), after (4 runs) | 6/6 | 0.3–12 s (varies with Gemini's labels) | 2.5–3.7 s |
| ES/PL 1 m, **one phone 250 ms slower**, worker before alignment (2 runs) | 6/6 | 0 s and **26.7 s** (+ 2 ghost caption segments, 365 chars); worker log: 30 + 45 leaked labels, 32 s + 49.5 s dropped | 3.6 s |
| ES/PL 1 m, one phone 250 ms slower, **after** alignment (`270a7ee`) | 6/6 | **0 s, 0 ghost captions**; log: 2 + 1 leaked labels, offset measured −220…−260 ms | 3.1 s |
| ES/PL 1 m, the *other* phone 400 ms slower, after | 6/6 | 0.35 s, 1 ghost caption of 1 character | 2.4 s |

The interjection is translated while the main speaker is still talking; its
"began before speaker stopped" is false only because a 2 s phrase is
translated right after it ends. Fixes, root causes and offline bench numbers:
`docs/architecture/WORKER.md` (Bleed guard). Raw results:
`docs/results/2026-11-17-sim-*.json`.

### 5b. Live screens with two simulated phones (2026-11-17)

`pnpm exec playwright test -c playwright.prod.config.ts` drives the deployed
app with two headless Chrome "phones" (390×844, fake microphones), using only
what is on screen. **PASS** (32 s):

- Start a gathering: no host-code field; Spanish/Argentina chosen; invite link has `#k=`.
- Guest opens the link, picks Polski, "Check my headset" → mic level + "Record & play" shown, consent, "Join the table".
- Both see each other; both mics on; guest's card for the host shows "translated".
- First Polish caption on the guest's screen **5.0 s** after the host's mic turned on (includes fake-mic start and speech onset).
- Private conversation "Outside": invite → "Join now" → both moved; guest "Leave & return to main" → host no longer visible to her.
- No page errors. Gathering ended afterwards (HTTP 200).

### 5c. First real two-phone test (owner + partner, 2026-11-17, 16:20–16:27 UTC)

Two people in one room, each with their own phone and Bluetooth headset
(models not recorded), Spanish (Argentina) ↔ Polish, on the deployed app.
Reported by the owner; worker logs read afterwards (language labels and
seconds only, no text or audio):

| What | Result |
|---|---|
| Translation into Spanish understandable | **Yes** (owner's report); English check still to do |
| Speaker labels on captions | **FAIL** — each person sometimes saw their *own* words as a caption under the other person's name |
| Worker log | Polish speaker's session heard Spanish 28× (and Polish 39×); 51.5 s of re-voiced audio dropped by the same-language rule; the captions had already gone out |
| Cause | the bleed guard only compared mic streams within ±120 ms; two phones deliver theirs with larger offsets → the partner's mic leak reached Gemini |
| Fix | stream alignment + caption retraction, `270a7ee`, deployed 2026-11-17 17:07 UTC; reproduced and verified in the live simulator (5a, last three rows) |
| Re-test on phones | second session the same evening — section 5d |

### 5d. Second real session (owner + partner, 2026-11-17, 20:28–20:46 UTC)

Same two phones, Spanish (Argentina) ↔ Polish, after the alignment fix. Worker
log only (language labels and durations; no text, no audio). The owner reported
the session finished and asked for a review; no specific problem was reported.

| What | Result |
|---|---|
| Duration | ~17 min; both directions translated throughout; one Gemini stream rotation (20:41) without a gap |
| Phone offset measured by the guard | **510–590 ms** (locks at +590, +570, +510 ms) — larger than the 250–400 ms simulated, close to the 600 ms search limit |
| Partner's voice on the owner's (Spanish) mic | Gemini labelled Polish **58×** (also 'pt' 14×, 'en' 7×; those may be the owner's own speech) |
| Owner's voice on the partner's (Polish) mic | Gemini labelled Spanish **37×** |
| Bleed guard (loudness-pattern match) | flagged **0.0 s** on both mics. Likely reason: room reverb, browser noise suppression and the headsets' own processing reshape the far voice, so its loudness pattern no longer matches the near one (the simulator's synthetic leak does not model this) |
| Same-language rule | dropped **95 s** (owner's mic) + **63 s** (partner's mic) of picked-up speech instead of re-voicing it; since `270a7ee` the captions of those stretches are retracted |
| Consequence | For two people with two different languages the language rule covers the leak. A table with three languages needed a better signal than loudness → the same-words check, section 5f |

### 5f. Three languages at one table: the same-words check (2026-11-17, local stack + real Gemini)

Local LiveKit `--dev`, the built web app and a local worker with **real
Gemini**; `table_sim.py` with Ian (es), Partner (pl), Friend (en) 1 m apart
(−20 dB leak + reverb, one phone 250 ms late), 30 s monologues each and a 2 s
Polish interjection over the English one. The loudness guard was switched
off to stand in for real phones, where it caught 0 s. Only runs published in
real time count (two overloaded runs, 1.14× and 1.21×, discarded).

| Worker | Overheard speech re-voiced (6 tracks, ~2 min) | Wrong-name captions | Real translations heard | First audio median |
|---|---|---|---|---|
| Loudness guard off, same-words check off | **157.9 s** | 9 | 8/8 | 6.6 s |
| Same-words check only, run A / B | **3.7 s / 4.6 s** | 0 / 0 | 8/8 / 8/8 (interjection included) | 4.0 / 4.2 s |
| Both on (production setting) | **3.4 s** | 2 | 8/8 | 2.6 s |

Getting there took four rounds, each found in the run before: judging every
matching mic (two far mics matched each other better than the speaker),
loudness for the owner's own voice (a 2 s interjection was muted, 6/8),
keeping the hold through mis-transcribed stretches and pauses, and a
non-Latin-script fallback (a far Polish voice came back spelled in Cyrillic
as 'ru'). Raw data: `docs/results/2026-11-17-sim-three-lang-*.json`.
**Not yet run on real phones.**

### 5e. Phone layout, saved tables, home-screen app, pocket mode (2026-11-17)

`tests/e2e-prod/screens.spec.ts` drives two headless Chrome "phones" (Android
user agent, touch, 2× pixels) through every screen at 360×740 and 390×844,
screenshots each one and fails if anything sticks out sideways.

| Check | Result |
|---|---|
| Before (production `270a7ee`) | room screen **wider than the phone** at both sizes: status pill, invite text and the Settings button cut off; people count wrapped onto two lines; an empty grid row pushed the people cards to the bottom |
| After (local production build) | **2 passed**, 21 + 20 screens, **0 overflow**; cards at the top, captions fill the rest, all five dock buttons fit at 360 px; 5+ people switch to three smaller cards per row; status moved under the table name so neither is cut |
| After (production `1d0c770`, 2026-11-17 ~21:35 UTC) | **2 passed** (1.2 min), 41 screens, **0 overflow**, no page errors; the saved-table flow and the one-tap return work live; every test profile deleted afterwards (HTTP 200) |
| Real translation through a saved table (production `1d0c770`, `walk.spec.ts`) | **PASS** (32 s): first Polish caption on the guest's screen **5.6 s** after the host's mic turned on, 148 caption characters 8 s later; private conversation and return to main OK; both profiles forgotten afterwards |
| Saved table flow | start a table → its link → guest joins and is remembered → both go home → table shows who is there now → guest taps once → back in the same conversation; all test profiles deleted at the end |
| Home-screen app | manifest + service worker were already present; added an install button (Android/Chrome) and iPhone instructions. **Installing on a real phone: NOT RUN** |
| Microphone with the screen off | browsers stop a web page's microphone a few seconds after the screen turns off, installed or not (Chromium issue 374374232; galene issue 342, Oct 2026; Apple developer forums for iPhone). Pocket mode keeps the page in front with a black, touch-locked screen. **On a real phone: NOT RUN** |

## 6. Not run (needs your devices or reviewers)

| Item | Why not | How to run |
|---|---|---|
| OpenAI backup provider | no `OPENAI_API_KEY` configured (optional) | add it to `translator/.env.local`, re-run `configure-cloud.ps1` |
| Provider A/B (accuracy, accents, names/numbers, voice consistency) | bilingual reviewers + OpenAI key | `PROVIDER_COMPARE=true`, see `docs/PROVIDERS.md` |
| Phone / Bluetooth / screen-lock / network-switch tests (beyond the one informal run in 5c) | needs the owner's phones | `docs/DEVICE_TEST_PLAN.md` |
| 8 physical devices in one room, acoustic bleed | devices + people | same |
| Saved table re-entry, home-screen install (Android + iPhone), pocket mode for 15 min, screen-off behaviour | needs the owner's phones | `docs/DEVICE_TEST_PLAN.md` rows 23–27 |
| Krisp noise / voice-focus filter | requires LiveKit Cloud | toggle in Settings once deployed |

## 7. Deployment (verified 2026-11-17)

| Piece | State | Evidence |
|---|---|---|
| Web app on Vercel `consultorios/eight-person-live-translator` | **Deployed and functional** | https://eight-person-live-translator.vercel.app, `/api/health` → `{"ok":true,"database":true,"databaseKind":"postgres","livekit":true,"internalApi":true,"hostCode":true,"commit":"64c86b9"}`; `/api/config` → `mediaConfigured:true, maxHumans:8, defaultProvider:gemini, perGatheringCapUsd:50`; functions in `fra1` |
| Postgres | **Neon, eu-central-1**, connected via the Vercel integration | health `database:true`; gatherings created/joined/ended by the probe |
| LiveKit Cloud worker | **Running**, agent `gemini-translator` (`CA_N7EbVp9hMsHu`), region eu-central, 1 replica | `lk agent status`: version `uQf4AVgJjxV4` (phone-offset alignment, `270a7ee`) deployed 2026-11-17 17:07 UTC (unchanged since) |
| Web app update: saved tables, pocket mode, phone layout (`1d0c770`) | **Deployed 2026-11-17 ~21:32 UTC** | `/api/health` → `{"ok":true,"database":true,"databaseKind":"postgres",…,"openCreation":true,"commit":"1d0c770"}`; `/manifest.webmanifest` → `id "/"`, `standalone`, 3 icons; `/sw.js` 200; `/api/me` without a cookie → `{"person":null,…}`; migration `002_people_tables` applied on first request; section 5e runs |
| Gemini key | configured on the worker only (never on Vercel, never seen by the assistant) | probe runs in section 5 |
| OpenAI key | not configured (optional backup) | — |
| Open gathering creation (owner's choice, family use) | **On** since 2026-11-17: `OPEN_GATHERING_CREATION=1`, no host code needed to start a gathering; guests still need the invite link; $50/gathering and $200/month caps and the creation rate limit unchanged | live `/api/config` → `hostCodeRequired:false`; `/api/health` → `openCreation:true, commit e37cb35`; live `POST /api/gatherings` without a code → 201, then ended; live form shows no code field |
| Earlier live checks (2026-10-30) | PASS | landing page 200 on a phone-sized viewport; security headers (HSTS, X-Frame-Options DENY, no-referrer, mic-only Permissions-Policy); uninvited `POST /api/gatherings/<id>/token` → **401** |

Next: rows 1–6 and 23–27 of `docs/DEVICE_TEST_PLAN.md` on two real phones
with Bluetooth headsets. Those are the only release gates still unverified.

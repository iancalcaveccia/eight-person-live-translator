# Translator worker — design, tunables, limitations

Code: `translator/src/`. Contract with the web app: [`CONTRACT.md`](CONTRACT.md).
Status labels below: **verified** = covered by an automated test that was run;
**not verified** = needs real credentials, phones or headsets.

## Data flow (one group media room)

```
mic track (48 kHz Opus) ─► SpeakerInput (one per human; VAD + bleed guard)
                               │  fan-out, one resampler per provider rate
                               ├─► TranslationSession (S → pl)  ─► tx:S:pl
                               └─► TranslationSession (S → en)  ─► tx:S:en
                                      │ InputGate (pre-roll/hangover)
                                      │ provider stream (Gemini WS, 100 ms chunks)
                                      └─ AudioOut ─► BacklogController ─► AudioSource
                                         Transcripts ─► outbox ─► lk.translation captions
```

| Module | Responsibility |
|---|---|
| `agent.py` | Entry point, dispatch metadata → `(gatheringId, groupId)`, wiring, shutdown |
| `router.py` | Demand (contract §3), session lifecycle, admission/eviction, budget, usage reporting, stats, idle shutdown |
| `session.py` | One streaming translation: connect, send, receive, reconnect, rotation, fallback, captions, events, metering |
| `audio.py` | `SpeakerInput`, `EnergyVad`, `BleedGuard`, `InputGate`, `Subscription`, `BacklogController`, sinks |
| `providers/` | `gemini.py`, `openai_translate.py`, `mock.py`, capability table, provider chain |
| `control_plane.py` | HMAC-signed admission/usage client, standalone mode |
| `events.py` | `RoomIO` (tracks, captions, `interp.events`, `interp.status`) and a fake for tests |
| `metering.py` | Per-session usage records and the cost model (contract §7) |

## Streaming guarantees (release gate)

- Audio is sent in fixed chunks (Gemini 100 ms, OpenAI 100 ms, mock 50 ms) as
  soon as they fill. **verified** (`test_audio_is_forwarded_chunk_by_chunk_while_input_still_streams`: 30 chunks, max inter-send gap < 350 ms).
- Translated audio is written the moment each provider chunk arrives; captions
  and events go through a separate outbox task so text can never delay audio.
  **verified** (unit + integration).
- Nothing waits for `turnComplete`, VAD end-of-speech, transcripts or
  punctuation. `turnComplete` is used only to segment captions.
- Overlapping speakers are separate sessions with separate tracks.
  **verified** in `test_overlapping_speakers_are_independent` and over real
  WebRTC in `test_interjection_is_heard_while_main_speaker_continues`.

### Measured with the mock provider over real WebRTC (local livekit-server 1.13.10, Windows 11, one host)

| Scenario | Mock provider delay | First translated audio at listener | Notes |
|---|---|---|---|
| 22 s es→pl monologue | 0 ms | 0.22 s | = pipeline overhead (two WebRTC hops + worker) |
| 22 s es→pl monologue | 1200 ms | 1.41–1.42 s | ≈ 100 % of the source speech that could already have been translated was heard before the speaker stopped (13.4–13.6 s of translated speech during the 22 s); end catch-up 1.42–1.43 s (no accumulation) |
| 1.5 s pl interjection at 8 s during 20 s es monologue | 1200 ms | 1.41–1.42 s after interjection onset | Heard while the main speaker was still talking; main translation kept flowing (~2 s of audio in the 3 s window) |
| latency probe, 2 reps, 12 s clip + 1.5 s interjection | 1200 ms | p50 1.39 s / p95 1.40 s; interjection p50 1.41 s | `scripts/latency_probe.py` smoke run |

These numbers characterise **our pipeline only**. Real Gemini/OpenAI
latency, phones, Bluetooth and mobile networks are **not verified** — run
`scripts/latency_probe.py` with real keys and then phone tests.

## Input gate (cost) — `INPUT_GATE=true`

Gemini bills input audio per second sent (25 tokens/s). Eight people in one
room = up to 16 sessions; streaming silence would cost ≈ 16 × $0.0053/min
≈ $5/h even when nobody talks. The gate withholds audio while a speaker is
silent:

- **Pre-roll 600 ms:** when speech starts, the last 600 ms are sent first, so
  onsets are never clipped. **verified**
- **Hangover 2.5 s:** audio keeps flowing 2.5 s after speech so the model can
  finish the sentence. **verified**
- **Fails open:** until the VAD has a noise-floor estimate everything counts as
  speech.
- Only providers that allow it (Gemini, mock). OpenAI requires continuous
  audio, so it is never gated. **verified**
- **Keepalive:** the real Gemini service closes a stream after exactly 120 s
  without input (`1008 Session closed due to client inactivity`, measured
  2026-11-17). Because the gate withholds silence, a quiet participant's
  stream used to drop and reopen every two minutes, so their first words
  could land in a ~0.5 s reconnect gap. Each session now sends 100 ms of
  silence after `STREAM_KEEPALIVE_SEC` (30 s) without input; with a silent
  chunk every 25 s the real service kept the stream open past 240 s.
  Cost: ~0.3 % of a quiet speaker's time. **verified** (unit tests + real
  service).
- Not verified with the real Gemini service: whether long input pauses change
  model behaviour. Set `INPUT_GATE=false` to compare.

## Bleed guard (same-room microphones) — `BLEED_GUARD=true`

Problem: at a dinner table each headset mic also hears neighbours. Without a
guard a neighbour's speech is translated through the wrong person's session:
with two people (ES/PL) that means **you hear your own words back** (Gemini
re-voices leaked Spanish into Spanish; `echoTargetLanguage=false` does not stop
it, partly because leaked Spanish is often labelled Italian), and with three
languages a third listener hears the same sentence twice.

Live simulation through the deployed app before the 2026-11-17 fix
(`scripts/table_sim.py`, 2 people 1 m apart, −20 dB leak with room reverb):
**42 s** of such "phantom" audio in 2 minutes. Root causes, found with the
offline bench `scripts/bleed_bench.py` (real worker code, no cost):

1. Envelope bins were keyed by arrival time; bursty delivery left holes that
   read as silence and broke the correlation (0.4–0.7 live vs 0.95 clean).
   Bins now follow each speaker's stream position, anchored to arrival.
2. Any miss let the gate open and its 2.5 s hangover forwarded the leak.

Guard now (speaker B, possible source A in the same room):

- **Detect**: A ≥ 13 dB louder (window medians) AND envelope correlation
  ≥ 0.90, **or** correlation ≥ 0.70 while B stays ≥ 14 dB under A's recent
  peak in ≥ 95 % of its active bins (a leak never approaches its source's
  level; reverb smears envelopes but not that bound). 3 consecutive hits.
- **Sticky**: stays flagged while A is still ≥ 13 dB louder; releases after
  6 misses (300 ms) once that dominance is gone.
- **Own voice wins**: a frame within 10 dB of A's typical recent level and
  ≥ 10 dB above B's leak level, for 80 ms (longer than network skew between
  phones), is B talking → the flag is held off for 1.5 s so interjections
  get through whole.
- **Gate/chunks**: a 100 ms chunk is speech only if its own-speech frames
  outnumber its leak frames; an open gate closes on a leak chunk instead of
  forwarding it during the hangover.
- **Second line** (`session.py`): output is dropped for 3 s after the
  provider labels the input as already in the target language (safe on real
  speech: the listener understands it). A broader "foreign label" rule was
  tried and removed — Gemini's labels for leaked audio are unstable (a
  speaker's own Polish was labelled 'en') and it dropped real translations.
- **Web**: browser `autoGainControl` is off, so silence no longer pumps a
  neighbour's leak up toward one's own level.

Results (synthetic voices, synthetic room; live = deployed app + real Gemini):

| Case | Before | After |
|---|---|---|
| Live, 2 people 1 m apart (−20 dB), 2 min | 42 s phantom, 6/6 translations | **0.0 s** in 4 runs, 6/6 |
| Live, 3 people (ES/PL/EN) 1 m apart | — | 8/8 translations, 1.9 s of 0.3–0.7 s blips over 6 tracks |
| Live, 2 people side by side (−12 dB, extreme) | — | 0.3–12 s per 2 min across 4 runs (leak ≈ a soft talker's level) |
| Offline bench, leaked speech sent at −20 / −28 dB (of 79 s) | 38–57 s | 5.5 / 6.4 s |
| Offline, soft interjection 6 / 12 dB quieter over a loud talker | — | 0.2 s of 8.9 s lost |
| Unit tests | 0 false flags for independent speech at 0/−6/−12 dB (kept) | + burst arrival, soft interjection, gate, majority vote, same-language drop |

Limitations: synthetic voices and rooms; real headset mics, phone noise
suppression and Bluetooth will change the numbers — the two-phone test is the
judge. Same-language listeners still hear any bleed in the *native* mic stream
(the guard only affects what is sent to the AI). Practical advice: headset mic
close to the mouth, people about 1 m apart; "Hold to talk" removes the
problem entirely for someone who wants it. Krisp BVC (background voice
cancellation) is a paid LiveKit Cloud feature beyond 100 min/month.

## Backlog control

`BacklogController` bounds accumulated delay of translated audio:

- Silent chunks are dropped when nothing is queued (leading-silence bursts
  would otherwise push the first words later; this cut pipeline overhead in
  the integration test from 1.30 s to 0.22 s). Real-time pauses are
  unaffected.
- Above `BACKLOG_SOFT_MS` (2.5 s queued) silences longer than 150 ms are
  trimmed and the session reports `delayed`.
- Above `BACKLOG_HARD_MS` (6 s) audio is dropped and counted (`droppedMs`
  in `stats`), so a stream can never stay minutes behind.

## Reconnect, rotation, fallback

- Unexpected close → immediate reconnect, then backoff 0.5/1/2/4/8/15/30 s.
  Audio produced while disconnected is buffered (≤ 2 s) and sent first on
  reconnect. **verified** (mock drop and fake-Gemini abrupt close).
- Gemini `goAway` → make-before-break: a new socket is opened and fed before
  the old one is closed (old drains ≤ 3 s). **verified** (mock and fake Gemini).
- Setup layout: transcription flags at `setup` level by default, automatic
  one-time fallback to the `generationConfig`-nested layout on a 1007/"Unknown
  name" rejection; both rejected → non-retryable error. **verified** against a
  fake server; **not verified** against the real service.
- Provider fallback after 3 consecutive failures (or a non-retryable one) to
  the next provider that supports the target; OpenAI never serves `pl`.
  **verified**.

## Admission and privacy

- Every human is admitted via `POST /api/internal/admission` before any
  session is created for them (as speaker or listener). Denied or
  `stale_epoch` (old token replay) → `RemoveParticipant`. **verified** with a
  fake control plane.
- Re-verification every 20 s; control plane unreachable → never-admitted
  humans are removed after 30 s (fail closed), already-admitted ones stay.
- Unknown room (404) → everyone removed, job shut down.
- No audio or transcript text is persisted or sent to the control plane;
  usage records contain only durations, counts and latency numbers.

## Budget and idle shutdown

- Usage reported every 15 s; `translation.allowed=false` closes every
  session within one reconcile and publishes `{"t":"budget","state":"exceeded"}`.
  **verified**.
- No humans → sessions closed at once; job shuts down after 30 s. **verified**.
- Standalone dev mode caps estimated spend at `STANDALONE_MAX_SPEND_USD` ($5).

## Tunables (env)

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_CHUNK_MS` | 100 | Input chunk size (Google recommends ~100 ms) |
| `OPENAI_CHUNK_MS` | 100 | Input chunk size for OpenAI |
| `GATE_PRE_ROLL_MS` / `GATE_HANGOVER_MS` | 600 / 2500 | Input gate |
| `BACKLOG_SOFT_MS` / `BACKLOG_HARD_MS` | 2500 / 6000 | Output delay bounds |
| `SESSION_GRACE_SEC` | 10 | Keep a session warm after mute / last listener leaves |
| `STREAM_KEEPALIVE_SEC` | 30 | Send 100 ms of silence after this long without input (Gemini idles out at 120 s); 0 disables |
| `BLEED_GUARD` | true | Same-room leak guard (tunables `bleed_*` in `config.py`, chosen with `scripts/bleed_bench.py`) |
| `IDLE_SHUTDOWN_SEC` | 30 | Job shutdown after the last human leaves |
| `ADMISSION_FAIL_CLOSED_SEC` | 30 | Remove never-admitted humans if the control plane is down |
| `USAGE_INTERVAL_SEC` | 15 | Usage report period |
| `TRANSLATOR_AGENT_NAME` | gemini-translator | Only for running a probe worker beside production |
| `MOCK_DELAY_MS` | 1200 | Mock provider latency |

## Known gaps

- Real Gemini 3.5 Live Translate and OpenAI sessions were not exercised (no
  keys in the build environment): setup acceptance, real latency, voice
  preservation, behaviour with gated input and long sessions (goAway timing)
  are **not verified**.
- No phone, Bluetooth or mobile-network testing was possible here.
- The Dockerfile was not built locally (no Docker on the build machine).
- Language switching: declared speakers use `echoTargetLanguage=false`
  (protects against re-voicing neighbours' same-language bleed); switching
  language mid-conversation requires changing `speak_lang` or using `auto`
  (then every listener hears the AI voice for that speaker).

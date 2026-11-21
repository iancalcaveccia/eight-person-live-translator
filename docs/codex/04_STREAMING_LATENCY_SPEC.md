# CRITICAL: Continuous simultaneous streaming translation

## Non-negotiable user experience

Eight people may talk at a dinner table, each with their own Android phone and Bluetooth headset. Each participant speaks in their own language (English, Polish, Spanish with AR/CO/ES preferences) and hears the others interpreted into their chosen language, starting shortly after the other speaker begins—not after they stop. Speakers must not have to take turns or press a button in normal operation.

**Pass/fail scenario:** Spanish speech starts at time 0: “Hola, me llamo Ian Luca. Soy de Argentina y estoy viviendo en Cracovia…” spoken WITHOUT stopping for at least 20 seconds. A Polish listener must already hear part of the Polish translated audio while Spanish speech is ongoing. Polish grammar can require a short initial context delay, but translation must not be gated on a completed utterance or pause. Test the reverse pair, English pairs, fast speech, long sentences and overlapping people.

## API choice

Use the dedicated Gemini 3.5 Live Translate API `gemini-3.5-live-translate-preview`, NOT standard Gemini Live conversational assistant or a normal chat completion API. Google explicitly specifies continuous speech translation without waiting for turn-taking: https://ai.google.dev/gemini-api/docs/live-api/live-translate

The baseline LiveKit repo is https://github.com/livekit-examples/gemini-live-translate (8-human room, separate `(speaker,target)` translation sessions, audio tracks for streaming). Preserve that design. Verify actual packet-to-packet behavior in the code before declaring it streaming; source audio must flow into the translator continuously and generated audio chunks must be forwarded into published tracks promptly.

No forced VAD endpointing, finish-sentence detection, stop-talking prompts, complete ASR transcript prerequisite, `turnComplete` batching, or one-speaker-at-a-time floor policy. The preferred model may buffer small contextual spans itself; this is not permission to buffer full speaker turns in our app.

## Overlapping speech and interruptions (equally critical)

Full-duplex, natural interjections are REQUIRED. Each participant may start a new utterance while others are speaking and translations are playing. Do not impose a global speaker lock, turn-taking gate, shared serialized translated-audio queue, or hard-mute the earlier speaker. A short “What?!”, “Co?!”, or “¿Qué?” must be interpreted into other listeners' headphones promptly with its own voice attribution, without waiting for a 20-second speech by somebody else to finish. Client-side audio mixing should allow two translated tracks briefly together, gently duck long-stream volume for short reactions, and permit user-controlled speaker focus when three or more people overlap. Retain original speaker stream, avoid runaway lag, and keep overlapping captions identifiable. Measure **interruption-onset-to-first-audible-translation** separately from first-speaker latency. Read 05_INTERRUPTS_AND_OVERLAP.md.

## Stream and playback design

- Android headset microphones capture separate individual WebRTC audio tracks. Configure WebRTC echo cancellation, noise suppression and automatic gain control where effective; avoid speech clipping from overly aggressive gating.
- LiveKit Python worker handles frames per source ID, targets only the distinct requested languages and publishes separate streams named `tx:<speakerID>:<targetLang>`; native passthrough for same-language listeners.
- Playback uses minimal adaptive jitter buffers and remains interruptible. A listener can receive overlapping translated tracks; support source focus, independent volume and manual ducking controls. Never silently lose speech when someone else starts talking.
- Transcripts/captions are supplemental; audio generation must NOT wait for final text or subtitles. No default cloud recording retention. Audio timestamps are not a promise that translated word boundaries align with source word boundaries.
- If the source changes language mid-sentence, attempt robust routing and show a notice where detection is uncertain. Spanish regional accents are preferences, not guaranteed output voices via `targetLanguageCode: es`.
- Prioritize natural phrasing at minimal lag; literal simultaneous word-by-word output can produce mistranslations due to grammatical differences. No exactly-zero-delay promises.
- Stable distinct voices are best-effort within the primary live model. Optional cloned voices/TTS are OFF by default and must never block the fast path.

## Instrumentation / targets

Timestamp locally or with calibrated synchronized test recording:
1. When source audible phonation begins (not merely when WebRTC track starts).
2. When first source audio frames reach the worker.
3. When first translated audio chunk arrives from Gemini.
4. When first translated audio sample actually becomes audible on a listener phone/headset.
5. Source-vs-translated rolling progress / lag during 20–60 seconds of continuous speech, and final catch-up delay.
6. p50/p95 start delay, stall count and length, dropped speech, audible voice changes, confidence/language issues and playback underruns.

Initial engineering aspiration under good Wi-Fi: first *audible* translated speech p50 <=3 seconds, p95 <=5 seconds; no fixed real-world promise until measured. Monitor rolling lag so it doesn't grow uncontrollably. Record performance for each of six directed pairs and at least 2, 4 and 8 participants, including overlapping speakers and crowded-room microphone leakage. Budget and costs scale with distinct speaker-to-target sessions.

On API throttling, delayed free tier, network drop, Bluetooth hiccups or model stalls, show “Translation delayed” and recover gracefully. Google Gemini free tier has had public reports of long latency; do NOT silently claim continuous low latency without paid-tier/baseline measurements.

## Acceptance report

For each test include: date, device/browser/headset, language pair, speaking duration, concurrent speaker count, start-to-audible delay p50/p95, rolling lag p50/p95, quality observations, whether translation began before the speaker ended, glitches, provider tier and estimated USD/hour. Mark hardware tests NOT EXECUTED unless real devices were used.

Reference: https://ai.google.dev/gemini-api/docs/live-api/live-translate

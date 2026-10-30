# CRITICAL: Natural interruptions and intelligible overlapping speech

## The user experience: interruptions are allowed, NOT turn-taking

In an eight-person in-person conversation with separate phone + Bluetooth headset microphones, **each participant must be free to begin speaking while someone else is still talking and while a translation is already playing**. The system must NOT lock the conversation floor to one speaker, discard a new speaker's audio, or wait for the previous speaker to finish before beginning interpretation.

Example (Spanish-speaking Ian and Polish-speaking friend):

- Ian: “Hola, ¿cómo estás? Te quería contar que…” continues speaking in Spanish.
- The friend starts hearing Ian interpreted into Polish shortly behind Ian's live audio.
- The friend interjects: “Co?! Serio?” (“What?! Seriously?”), **while Ian is still talking**.
- Ian promptly hears that short interjection translated into Spanish in the friend's distinct voice even while his own microphone stream continues uplinking and the friend may still be listening to Ian's translated voice.
- The continuing speaker must not be muted as a condition of allowing the interjection. The playback mixer may temporarily *duck* the longer stream so the short interruption is intelligible.
- In a group, overlapping two distinct translated voice streams is ACCEPTABLE and sometimes desirable. Audio chaos from four simultaneous full monologues is not. Offer a comprehensible, user-adjustable mix without pretending to perfectly reproduce all voices simultaneously.

## Engineering rules

1. **No global floor / no half-duplex.** Keep one independent captured audio track per HUMAN participant, continuous full-duplex WebRTC sending/receiving, per-speaker per-target-language translation streams, concurrent ASR/AI processing. No press-to-talk, automatic meeting-wide muting, token or wait-for-turn gate as the default.
2. **Preserve speaker attribution through overlap.** Each live translated packet/track is associated with the unique source participant ID, stable display name, language and independent audio clock. A listener can recognize a short interruption by voice and visible speaker indicator; don't concatenate two peoples' text or audio into a single voice.
3. **Low-latency interruption handling.** Publish translated output as soon as the engine produces it, independently for the interrupter; do not queue it behind the dominant speaker's pending utterance. Measure interruption-onset-to-first-audible-translation, not merely main-speaker latency. Attempt to keep that near normal streaming latency, not an unbounded queue.
4. **Client-side per-listener audio mixing.** Mix separate incoming audio tracks (native for same-language peers, translated for other-language peers) using Web Audio / AudioWorklet when permitted by browser. Use transparent, bounded playback buffers. Avoid a single serialized speech-output queue shared by all people. Avoid hard left/right panning that harms single-earbud users; provide optional subtle spatial balance if compatible.
5. **Default Gentle Interruptions mode.** Initially mix up to two active speakers at reasonable volume. When a new voice briefly interjects (~0.3–3 seconds, tunable), reduce the *other incoming* track(s) by roughly 5–9 dB with fast attack (~80–150 ms) and smooth release (~400–700 ms) rather than muting them. These are configurable starting parameters, not validated acoustic optimums. Do not duck user's microphone uplink or their own hearing of the physical room. Restore balance smoothly after the interjection.
6. **Not every new talker is an interjection.** Distinguish short acknowledgments from sustained competing monologues via duration/activity and context, not hard-coded language words alone. If two people keep talking, preserve their audio and offer an unobtrusive focus control: 'Both', 'Focus on [name]', 'Auto balance'. Don't secretly drop speech. When >2 sources remain active, smoothly prioritize most relevant/recent or user-focused audio for intelligibility, make all speakers visible in captions, and let users select whose speech to hear more loudly. Make that policy user-configurable. **No false promise** that a listener can understand four voices simultaneously.
7. **Own speech must remain live.** Someone must be able to speak while hearing another person's translated interruption through their Bluetooth headset. Ensure the mic capture does not halt because speaker playback begins; verify AEC, noise suppression, Bluetooth full-duplex profiles, sound leakage and Android routing. Headset microphones may switch to lower-quality bidirectional Bluetooth modes; do not claim fidelity is guaranteed.
8. **Continuous translation during overlap.** Main speaker's translation carries on through a brief interjection; translated stream may be attenuated, not paused or reset. Per-source translator sessions and jitter buffers must remain independent; interrupted streams catch up without burst playback or accumulated latency.
9. **Subtitles as safety net.** Display simultaneous text with separate participant labels/colors, timestamps and short history for anything obscured by an overlapping voice. User may tap a speaker to focus or replay a caption with consent, but replay is opt-in and must not postpone incoming live interpretation. No audio recording by default.
10. **Distinct voices, not necessarily clones.** Native model voice preservation is best effort. Offer per-participant *consented* fixed output voice preference when available; do not infer gender as a fixed property from voice. Optional exact voice cloning requires adult voice-owner consent and must not delay the fast translation path.
11. **Same-room microphone bleed is a major risk.** Eight phones hear each other acoustically, and remote translated playback may be picked up as new source speech. Use directional headset mics, AEC/noise suppression, per-speaker source identity, suppression of translation-track feedback, mic level diagnostics, and document residual crosstalk. Do not assume eight phones provide perfect isolation.

## Real-world acceptance cases (implement and test)

- **2 people, short interruption:** one person speaks nonstop for 20 seconds; other interjects a 1–2 second Polish/Spanish reaction at second 8. Both source microphones continue transmitting. The reaction begins playing translated on the original speaker's headset *without waiting for the 20-second monologue to finish*. Ongoing translation continues and remains comprehensible; audio attribution stays correct.
- **3 people, two short interjections:** Spanish main speaker, English and Polish interruptions within a few seconds. Each reaches the appropriate listeners, distinct voices and captions preserved, with no source lost or prolonged queuing.
- **4 people overlapping:** two sustained speakers, one 1-second interjection. Test Gentle Interruptions, Focus on speaker, Both modes; record intelligibility and lost words.
- **8 people in one room:** real Android phones and Bluetooth headsets with background voices, music and microphone leakage. Vary headphones, screen lock, simultaneous speaking and reconnect. Record echo, false voice triggers, delay and congestion. Mark unexecuted tests honestly.
- **Language matrix:** all six directed pairs among Polish, English and Spanish. Spanish accents: Argentina, Colombia and Spain. Interjection words like “¿Qué?”, “What?”, “Co?”, “Serio?”, “No way”, and longer spontaneous comments.
- **Latency metrics:** main-stream audible delay; interruption-onset-to-first-audible-translation p50/p95; amount/time of competing-audio ducking; number of dropped/misattributed interruptions; recovery time when speakers cease overlap; jitter and backlog. Aim for interruption delay not materially worse than non-overlap baseline, noting model/API limits and no guaranteed zero lag.
- **Quality regression:** verify no forced turn-taking, no waiting for silence in a different source stream, no hard suppression of every second voice, no infinite backlog, and no hallucinated duplicate audio from echo.

## Product design defaults

- Default: **Natural Conversation / Gentle Interruptions ON**; user can switch to **Focus on Speaker** for crowded sessions.
- No global push-to-talk. Allow participant self-mute and per-listener volume controls.
- Mark all active talkers with clear names; render concurrent live captions in separate lanes.
- Provide concise privacy disclosure about streaming microphone audio to translation providers. Do not record or persist raw audio by default.
- Streaming > intelligibility of short interjections > precise cloned voice. If voice cloning hurts interruption latency, turn it off and use native voice-preserving streaming.

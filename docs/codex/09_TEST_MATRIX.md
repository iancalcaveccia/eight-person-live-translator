# Acceptance checklist (do not claim tests passed unless executed)

## Release-gating private breakouts and participant roaming (CO-HIGHEST PRIORITY)

- [ ] 8 people join ONE gathering. Split 5 in `Living room` and 3 in `Outside`, speak in Polish/Spanish/English simultaneously: no native, translated audio or captions route across the two group boundaries.
- [ ] Repeat with 4+4, 3+3+2, four pairs. Each group's streamed translation and short interjections continue normally.
- [ ] A participant is invited outside, declines, then accepts. They leave old audio/subtitles, join the new group, and can return to Main without a new QR/login/headset setup or loss of voice identity/language settings.
- [ ] Attempt to guess/join/subscribe to an unauthorized group room or caption endpoint, replay an old media token, or exploit multiple tabs and network reconnection; all cross-group reads/publications must fail server-side.
- [ ] Test leaving/entering while source and translated audio are mid-stream; no stale old-group buffer should play after switch. The mic never publishes to old and new media rooms simultaneously.
- [ ] Test invite-only group privacy, metadata visibility, group owner removing a member, host ending gathering, empty groups cleanup, Wi-Fi outage during switch and an invite acceptance race.
- [ ] Report measured group-switch delay and media downtime (do not invent sub-second claims), with audio-only device/background limitations; identify possible *acoustic mic bleed* when groups are physically close.
- [ ] Confirm per-group AI sessions, subscription permissions and billing stop when last relevant listener leaves; no global speech/caption recording by default.


## Release-gating live simultaneous translation (HIGHEST PRIORITY)

- [ ] During 20+ uninterrupted seconds of Spanish speech, the Polish listener hears translated AUDIO begin **before the speaker stops**; use a timestamped screen/audio recording as evidence (with consent).
- [ ] Repeat uninterrupted 20+ second monologues in all 6 directed language pairs: es->pl, pl->es, en->pl, pl->en, es->en, en->es.
- [ ] Demonstrate that Gemini's streaming translated audio chunks are published to WebRTC as they arrive; no wait for `turnComplete`, VAD silence, complete transcription or sentence punctuation.
- [ ] Collect source onset -> first audible translated sample and p50/p95 values; initial *aspirational* targets median <=3 s and p95 <=5 s on good Wi-Fi, explicitly report misses. Track steady-state rolling lag and end catch-up; do not mislabel API processing-only latency as total end-to-end latency.
- [ ] Verify that interruptions, punctuation and natural pauses do not cause lengthy stalls, missing phrases, doubled speech or translated words in the wrong speaker's track.
- [ ] Verify at least two participants are free to SPEAK while their own incoming translated audio is playing; no mandatory floor control or mute-based turn taking.
- [ ] Test 2 and 4 simultaneous talkers in an eight-device dining room, and note limitations when translation tracks compete for listener attention.
- [ ] Test 60 seconds of continuous talk with background music and repeated code-switching, checking that stream delay does not accumulate indefinitely.
- [ ] Confirm advanced voice cloning and any synthetic voice mode can be disabled instantly if it increases live latency; baseline fast mode has no cloning dependency.
- [ ] Simulate API stalls/rate limits and Bluetooth output buffering; app warns "Delayed" rather than pretending to remain live, and can reconnect without wrong-speaker routing.


## Functional

- [ ] 2 phones English -> Polish -> English with two standard Bluetooth headsets.
- [ ] 3 phones speaking one each English, Polish, Spanish; every listener receives correct chosen language.
- [ ] 4 simultaneous participants; each speech track identified by correct participant name.
- [ ] 8 Android phones/headsets connected, verified stable for 15 minutes; if unavailable, record test as NOT EXECUTED.
- [ ] Source language equals listening language -> native passthrough, no AI cost for that particular speaker/listener pair.
- [ ] One source English and three Spanish listeners -> only one reused English-to-Spanish translation track/session.
- [ ] Unique translated speaker identity per source; voice sounds broadly appropriate, label if model voice shifts.
- [ ] All three Spanish regions available as UI preference; disclose generic `es` model targeting.
- [ ] No API keys in browser bundles, repos, logs, screenshots.
- [ ] Consent screen before any microphone capture or AI processing.
- [ ] Room-level spending cap stops work and informs listeners.

## Quality and performance

- [ ] Measure latency p50, p95 for en-pl, pl-en, es-pl, pl-es, es-en, en-es (10 passages each).
- [ ] Accent test: Argentinian, Colombian, Spanish from Spain, Polish native speech; quality reviewed by bilingual humans.
- [ ] Male/female/other voice presentation by each speaker's stated preference; no gender inference from microphone data.
- [ ] Proper names, colloquialisms, jokes and interruptions.
- [ ] Two people speaking at once: no cross-contamination or wrong name; document unavoidable intelligibility limits.
- [ ] 8 headset microphones in one dining room (background speech, glasses clinking, music); measure bleed and echo.
- [ ] Bluetooth mic denied/unavailable: automatic phone-mic fallback and visible status.
- [ ] Android screen lock, app switching, Wi-Fi/LTE changes, headphone disconnect and reconnect.
- [ ] Default voice fidelity A/B Gemini vs OpenAI; don't claim voice clone if using voice preservation.
- [ ] If experimental voice cloning built: explicit consent, removal, voice ID isolation, benchmark extra delay.

## Reporting

Publish supported languages, documented measured latencies, translation costs by scenario, device/browser matrix, serious bugs, and a deployment URL only if deployed.

## Release-gating natural interruptions and overlap

- [ ] During a 20-second uninterrupted Spanish monologue, a Polish listener says “Co?! Serio?” at second 8; original speaker hears translated interruption BEFORE the monologue ends; neither source is muted or reset.
- [ ] Repeat in reverse Polish/Spanish and with English; both participants can speak while hearing a translation, even with Bluetooth microphone active.
- [ ] Verify two overlapping translated tracks can be audible briefly, each with distinct source identity/voice and independent captions; default Gentle Interruptions mix ducks longer stream smoothly, then restores it.
- [ ] Test 3 and 4 overlapping speakers; audio is not silently discarded, focus controls work and captions surface less audible speech.
- [ ] Test all eight phones in same room for crosstalk, BLE/Bluetooth mic profiles, AEC, rebroadcast feedback and duplicated translations.
- [ ] Log interruption-onset to first translated-audio-playback p50/p95, source attribution errors, audio loss, translation backlog, competing-stream volume and user-perceived intelligibility.
- [ ] State clearly that no mode guarantees understanding multiple sustained simultaneous monologues; no end-of-utterance batch fallback is silently enabled.

# Engineering architecture (reference design)

## Two-layer rooms: gathering presence versus active group media

**Do not use a single all-participants LiveKit media room plus frontend mute as a privacy boundary.** The existing upstream example likely assumes one media room, so explicitly refactor it: use an invitation/presence control-plane gathering and separate authenticated LiveKit media room instances for `Main`, `Outside`, `Kitchen`, etc. A participant belongs to the gathering persistently but can publish microphone audio and subscribe to audio/captions in only ONE current media group. Implement atomic move authorization, one active group epoch per participant, and stop old-group tracks before publishing in the new group. Rejoin main without a new gathering invite.

Worker sessions and publications use **`(gatheringId, groupId, speakerId, targetLanguage)`**, never `(speakerId,targetLanguage)` alone, and publish only inside the corresponding LiveKit group media room. Group invitations and private membership are enforced by the backend, with short-lived room-scoped media tokens; server rejects cross-group subscription even when manipulated outside the browser. UI shows only authorized group metadata. No shared caption bus across group boundaries. Revoke/expire old authorizations, discard buffered audio/captions on switching, and close unused translation sessions. Measure transition time and temporary audio unavailability rather than promising perfectly seamless roaming. A microphone physically capturing speech from a nearby group remains an acoustic leakage risk; isolation here concerns server routing, not magic noise cancellation.

Full requirements and adversarial tests: `06_BREAKOUT_PRIVACY_SPEC.md`.

Participant device x8:
  Bluetooth headset mic -> Android browser/HTTPS -> LiveKit mic track
  LiveKit authorized group native or translated streams -> Bluetooth output

Each independent LiveKit conversation room:
  Human participant ID, source language, listener language, optional Spanish variant
  Python translation worker subscribes to separate source mic tracks
  Translation sessions keyed by `(gatheringId, groupId, speakerID, targetLanguage)` and only created on demand
  Translated audio published within the current media group as `tx:<speakerID>:<targetLanguage>`
  Captions published with source participant ID and target language metadata
  Authorized client subscribes to native source if languages match, else translated track, within its active group only

Example with 3 languages and 8 participants (one group; splitting may reduce simultaneous translation targets):
  One Spanish speaker may require two Gemini sessions: to Polish and to English.
  One Polish speaker may require two: to Spanish and to English.
  One English speaker may require two: to Polish and to Spanish.
  Upper illustration: up to 16 source-target streams for eight speakers, NOT 56 independent participant-to-listener streams.

Continuous low-latency translation: NON-NEGOTIABLE
  Native mic track delivers ongoing frames via LiveKit WebRTC (do not wait for full utterance or final ASR event)
  Worker forwards stream in real time to Gemini 3.5 Live Translate BidiGenerateContent translationConfig
  Gemini audio response chunks are published to target-language track immediately, with a minimal jitter buffer at playback
  Track identity and audio clock per (speakerID,targetLang); preserve independent speakers during overlap
  Never use turn-based conversational agent mode or end-of-speech buffered TTS as default
  Priority: streaming first, voice matching second, optional cloning last
  Add per-stream metrics: microphone onset, first translated audio generated, first sample played,
    rolling delay vs source, p50/p95 and stall count; instrument timing without recording private audio
  Read 04_STREAMING_LATENCY_SPEC.md for measurable thresholds, test matrix and failure behavior.

Full-duplex interruptions and overlap: REQUIRED
  Independently capture and translate each participant even when other participants speak; no global floor or serialized speech queue.
  Per-listener browser Web Audio mixer receives separate native/translated speaker tracks; default Gentle Interruptions mode can mix two active speakers and gently duck the earlier/longer stream on short interjections.
  Do not mute/reset/pause a translated stream when another begins; retain each source identity and captions separately.
  Offer Both / Focus / Auto balance for >2 overlapping streams. Never pretend 4 simultaneous monologues are intelligible.
  Measure interruption-onset -> first audible translated reaction separately from primary-stream latency.
  Same-room mic bleed, translated-audio feedback, Bluetooth full-duplex audio profiles, AEC and active-speaker misdetection require real-device testing.
  Read 05_INTERRUPTS_AND_OVERLAP.md for mixing defaults, realistic limitations and acceptance cases.


Voice:
  Default = Gemini 3.5 Live Translate native adaptive output; no promise of stable cloning. Google's documentation warns perceived voice can shift and assign wrong-sounding voice after pauses or rapid speakers.
  Experimental = Gemini 3.8 TTS voice replication (separate text->speech pipeline) with adult consent and recorded source/consent clips. Higher latency; must be measured. No guaranteed fast voice replication in native Live API.
  Alternative = OpenAI gpt-realtime-translate voice adaptation; no voice selection parameters on this translation model.

Latency target:
  Instrument median and p95 source onset to first audible translated audio, and last-source-audio to last-translation-audio. Set engineering targets only after baseline measured; do not advertise a fixed guarantee.

Cost:
  Google lists ~US$0.0053/min input audio and ~US$0.0315/min generated translated audio, priced on audio tokens. Output only exists when translation is produced; actual costs depend on silence, usage, streams, and billing semantics. In an extreme illustrative 16-stream, fully active hour, 16 * 60 * (0.0053 + 0.0315) = $35.33, not a predicted typical hour. Also pay LiveKit/hosting. Avoid unlimited always-on room sessions; show cost estimate and enforce budget.

Security and privacy:
  Short lived, room-scoped LiveKit tokens; server-side Gemini/OpenAI keys; HTTPS/WSS; admission control; no long-term audio retention by default; explicit mic-processing consent; participant-visible AI disclosure; no cloning of unconsenting people; erase cloned voice on request; limits and rate limiting.

# ALL-IN-ONE: Eight-Person Interpreter Codex Handoff

This is the full prompt and technical documentation bundled into a single file. Paste/attach `01_MASTER_CODEX_PROMPT.md` first; use this file as complete reference. No app is deployed by this document.



---

# SOURCE FILE: 00_START_HERE.md

# START HERE — Eight-person streaming interpreter (Codex handoff)

**Package status:** COMPLETE BUILD DOCUMENTATION, NOT AN IMPLEMENTED OR LIVE APPLICATION. The project does not magically deploy after uploading these docs. The existing upstream starter is an actual working reference app, while all custom features in this pack require engineering and real phone tests.

## Your personal build checklist

### Accounts (one developer account per platform — guests do NOT need subscriptions)

1. GitHub: account/repository to hold code. You already connected GitHub to ChatGPT; Codex may require selecting/authorizing it separately. Open https://github.com/livekit-examples/gemini-live-translate and click **Fork**, or use GitHub's template/import features according to repository options. Suggested fork name: `eight-person-live-translator`.
2. Codex: https://chatgpt.com/codex — select your fork as the working repository or open a local folder with Codex CLI. Give Codex access to this documentation, ideally by extracting its contents into your fork's `docs/` folder. Paste `01_MASTER_CODEX_PROMPT.md` as the first task. Tell it to implement **M0 and M1 immediately**, not just generate another plan.
3. LiveKit Cloud: https://cloud.livekit.io — create a project, obtain LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET; configure secrets securely.
4. Google AI Studio: https://aistudio.google.com — enable paid API if required, create `GEMINI_API_KEY` and set billing alerts. Validate `gemini-3.5-live-translate-preview` availability and current pricing.
5. Vercel: https://vercel.com — connect GitHub fork; deploy Next.js frontend there, after Codex has built a secure token endpoint.
6. Managed Postgres, e.g. Neon or Supabase — for authorized gatherings, invitations and breakout membership. Select after reviewing M4 data model. Keep DB connection URL server-side.
7. Optional: https://platform.openai.com — `OPENAI_API_KEY` for second model experiments. NOT required to launch the first Gemini MVP.

### Do NOT expose keys

API keys belong in LiveKit/Vercel server secrets or ignored `.env.local` files. Never paste them into a public repo, shareable screenshots, the browser UI or Codex prompts. Use placeholders.

### Local test and deployment sequence

1. Fork upstream source; inspect MIT license and README.
2. In a local clone: `pnpm run setup` at project root; fill the upstream `.env.local` placeholders and `translator/.env.local` *locally*; run `pnpm run dev` (current upstream documented command; recheck after code changes).
3. Test existing 2-person demo with two actual devices and working headsets. That baseline is NOT yet a test of your desired custom features.
4. In Codex: include this package in the repo, execute the master task and implement milestone M1. Review tests, code and visible realtime behavior.
5. Add stages M2–M4, including breakout privacy and natural interruptions. Deploy frontend on Vercel and agent on LiveKit Cloud when ready.
6. Do real phone tests under Wi-Fi and cell data before inviting eight people. Native mobile wrappers are an option if the browser cannot continue microphone/audio reliably with the screen locked.

## Absolute top requirements

- Eight total humans, each with independent phone + Bluetooth headset, speaking EN, PL or ES.
- Spanish preferences: Argentina, Colombia, Spain; these are preferences, NOT guarantees of accent-specific model output.
- Audio translation **starts before the source speaker finishes**, with fast but nonzero rolling lag.
- Natural interruptions: multi-speaker concurrent translations; no force-stop/press-to-talk global floor.
- Each source has distinct labeled translated tracks; model voice quality/identity best-effort; optional explicit opt-in cloning later.
- Private breakout subgroups that actually isolate audio/captions server-side, while sharing parent gathering presence.
- Transparent monitoring, cost caps, no secret leakage, no default recordings.

## Files and recommended reading order

1. `01_MASTER_CODEX_PROMPT.md` — the one message to paste into Codex.
2. `02_PRODUCT_REQUIREMENTS.md` — experience and languages.
3. `03_TECHNICAL_ARCHITECTURE.md` — LiveKit/Gemini/Next.js and media topology.
4. `04_STREAMING_LATENCY_SPEC.md` — simultaneous interpretation release gate.
5. `05_INTERRUPTS_AND_OVERLAP.md` — natural speech overlaps and ducking.
6. `06_BREAKOUT_PRIVACY_SPEC.md` — separate authorized media rooms and group privacy.
7. `07_SPEAKER_VOICES.md` — voice identity, cloning and consent.
8. `08_MOBILE_AND_BLUETOOTH.md` — mobile realities and headset testing.
9. `09_TEST_MATRIX.md` — tests inherited from previous project brief.
10. `10_DEPLOYMENT_AND_ENV.md` — exact hosting responsibilities and variable checklist.
11. `11_SECURITY_COST_AND_OBSERVABILITY.md` — trusted server rules, spending limits, metrics.
12. `12_MILESTONES_AND_REPORTING.md` — how Codex proves it has really built things.
13. `13_REPO_HANDOFF.md` — Codex task and GitHub instructions.
14. `14_OFFICIAL_REFERENCES.md` — docs and verified model restrictions.
15. `AGENTS.md` — repository-wide instructions for AI coding agents.
16. `ENV_EXAMPLE_FRONTEND.env` and `ENV_EXAMPLE_WORKER.env` — sample placeholders, not actual secrets.

The upstream quickstart is `https://github.com/livekit-examples/gemini-live-translate` and under MIT license. Respect its source as the implementation baseline.



---

# SOURCE FILE: 01_MASTER_CODEX_PROMPT.md

# MASTER CODEX PROMPT — Eight-person low-latency live interpreter

**Paste this whole file into a Codex coding task.** Place the companion Markdown files in the repository before running the task. Work in the user's GitHub fork of `https://github.com/livekit-examples/gemini-live-translate` (MIT license), not in upstream. Date of specification: October 27, 2026.

## Mission and authority

You are the principal full-stack realtime-media engineer building a REAL, USABLE, DEPLOYABLE multilingual simultaneous-interpreter application. Do the coding, tests, configuration and documentation, not only a plan or static mockup. Extend and validate the MIT-licensed LiveKit/Gemini translation project at https://github.com/livekit-examples/gemini-live-translate. First inspect the live upstream repository and its current dependencies and APIs; if it differs from these instructions, reconcile and document the differences. Preserve attribution and license.

The desired end state: eight humans, each using their own iOS or Android phone and ordinary Bluetooth headset microphone/speaker, join one invite-only gathering via URL/QR. The humans may speak English, Polish, Spanish (Argentine, Colombian or Spain accent preference). Each hears all *authorized speakers in their CURRENT CONVERSATION GROUP* in their selected listening language. Translation begins while a speaker is still speaking, continuously; people can interrupt with brief remarks, and the listener can hear more than one recognizable voice. Participants may split a gathering into private subgroups (5+3, 3+3+2, 4+4, four pairs, etc.) and return to the main group without re-invitation. Audio and captions must never leak across groups. Put the frontend on Vercel and the long-running WebRTC/translation worker on LiveKit Cloud.

## Primary priorities, in order

P0 Security, privacy, real usable audio connection, server-side authorization, API key secrecy, and controlled costs. A private conversation must be ACTUALLY private at the media layer.

P0 Continuous STREAMING speech-to-speech translation. Absolutely NO 'talk, stop, then translation begins' implementation. On a 20–60-second uninterrupted monologue, translated audio must begin before the speaker stops.

P0 Full-duplex interruption handling. If speaker A talks for 20 seconds and B interjects 'Co?! Serio?' at second 8, A can continue speaking, B can continue listening, and A hears B's translated interjection promptly; independent streams are not serialized or locked to one speaker. Gentle audio ducking and source focus are allowed; automatic hard muting or dropping translations is not.

P0 Private breakout conversations within the same eight-person gathering. Anyone invited to a group may enter; a participant is active in exactly one media group at a time. Group membership and authorization are enforced on servers, not only in the UI.

P1 Stable audible speaker identity. Use the live model's voice adaptation as a best-effort default. Associate tracks with a unique human participant ID + name and show captions by speaker. Do NOT falsely promise exact voice replication or reliable inferred sex/gender. Offer self-selected voice presentation where the actual API supports it, and otherwise accurately disclose limits. Optional verified, revocable adult voice cloning is an isolated experiment and must never delay/compromise the realtime fast path.

P1 Practical mobile behavior: per-user Bluetooth input/output tests, Android Chrome and iOS Safari support, echo cancellation, microphone-bleed controls, reconnection, screen-lock warnings, installable PWA after browser prototype passes. A native Android/iOS client using the SAME media backend is an optional later phase if background audio and routing cannot reliably work in browser.

P1 Provider A/B: Google Gemini live translate primary; OpenAI `gpt-realtime-translate` optional alternate behind a provider abstraction. Verify current docs, config and billing for BOTH providers rather than copying voice-assistant API behavior. No unverified provider claims.

P2 UI polish, advanced accent customization, optional voice replication, recordings (OFF by default) and other enhancements.

## Non-negotiable user-facing behavior

1. Simple host flow: Create gathering -> share link/QR -> invited participants join with display name, speech language, listening language, optional Spanish region (Argentina / Colombia / Spain), headset audio self-test, explicit AI-audio consent.
2. Eight PEOPLE maximum per gathering (system/agent tracks do not count toward this limit); no participant needs eight subscriptions. Each participant operates their OWN phone and Bluetooth headset.
3. Accepted directed language pairs: `es→pl`, `pl→es`, `en→pl`, `pl→en`, `en→es`, `es→en`; same-language users hear original speech without translation. Accents `es-AR`, `es-CO`, `es-ES` are UI/test preferences, not guaranteed dialect-specific model output. Do not force English as a pivot without an A/B evaluation.
4. One upstream microphone track per human, identified by stable `participantId`; server-controlled translation stream keyed by `(gatheringId, mediaGroupId, sourceParticipantId, targetLanguage)`. Demand-driven reuse: a source translated to Polish once should feed *all authorized Polish listeners in that group*, not one paid translation per listener.
5. Source mic audio flows to translation as low-latency PCM chunks, not as final transcripts. Google model id `gemini-3.5-live-translate-preview`, official `translationConfig`, 16 kHz input / 24 kHz output and ~100 ms input frames per current Google docs. Use upstream code when it is correct; inspect changed APIs before coding.
6. Independently publish translated audio for each source + target with speaker ID metadata; captions labeled with name, language and timestamps. Client plays native audio to same-language listeners and translated audio to other-language listeners, never both for the same speaker by accident.
7. Stream AI audio output immediately with minimal bounded buffering. Streaming speech can naturally lag by seconds due to syntax and model behavior. Optimize p50 first-audible-output under three seconds on strong Wi-Fi and p95 under five seconds as a DESIGN GOAL, not as a promise. Log actual speaker onset -> first sound played; separately test uninterrupted speech, 1-second interruptions, recovery, and 8-person cross talk.
8. Default 'Natural Conversation' audio mixer accepts two overlapping translated voices with brief gentle ducking; for >2 offers per-listener focus/priority while all authorized captions remain available. No enforced turn-taking. Use correct channel handling for a single-earbud user.
9. Breakouts: whole gathering presence remains alive. Participants create invitation-only subgroups, invite/accept/decline, switch groups without losing headset pairing, rejoin Main. Separate secure LiveKit media rooms per subgroup, or demonstrate equally secure server-authenticated isolation. One active group epoch per user. On switching: stop/revoke old media, stop worker sessions, clear queued captions/audio and issue short-lived room-scoped token only for authorized new group. Unauthorized media subscriber cannot join another subgroup by editing URLs, room IDs, or tokens. No cross-group recording or metrics content.
10. Speakers may physically hear people in another group if nearby. A mic can capture that nearby voice acoustically: warn that server isolation does not solve sound leaking into a microphone.
11. Per-user controls: mute mic, headphone self-test, active group, speech/listening languages, translation state, caption on/off, focus speaker, optional native/translated balance and reconnect banner. No misleading toggles for unimplemented features.
12. Error flows: AI timeout, network loss, headset disconnect, Safari background suspension, service quota exceeded, too many speakers, group move conflicts. Show clear user-facing status; close stalled paid sessions and recover gracefully.

## Architecture: honor the existing upstream project

Inspect `livekit-examples/gemini-live-translate` and its current README, source, data model and MIT license. The existing reference includes Next.js frontend, LiveKit WebRTC rooms, Python worker, on-demand `(speaker,target-language)` Gemini sessions, separate native/translated tracks and eight-person default. Run its original demo before refactoring. Make smallest sound changes needed. The repository's existing `pnpm run setup`, `pnpm run dev`, `translator/Dockerfile`, LiveKit CLI process and `/api/token` route are starting points, not guarantees once security is added.

Suggested technology:
- Next.js App Router + React/TypeScript on Vercel for UI, gathering control endpoints and short-lived scoped token minting.
- LiveKit Cloud SFU for bidirectional WebRTC media; LiveKit-hosted Python agent worker for source-track subscription and per-language speech-to-speech streaming. Place EU worker region near Kraków as practical; test actual regions and service availability.
- Postgres (e.g. managed Postgres via Neon or Supabase) for authoritative gathering, host, participant, invitation, subgroup membership, active group/epoch and spending policies. If adopting a different DB, explain why. No sensitive voice audio saved there.
- Google Gemini Live Translate preview as primary engine, through server-only secret. Encapsulate translation as an interface so OpenAI dedicated translation API can be tried without rewriting room logic. For OpenAI backend use `/v1/realtime/translations`, NOT standard voice-assistant endpoint `/v1/realtime` and NOT `response.create`. Feed 24 kHz PCM16 in ~200 ms frames per current docs.
- Next.js is NOT an always-running media worker. Vercel hosts UI/API, LiveKit Cloud hosts long-lived media and translator process.

## Security and privacy requirements

- Must NOT leak LiveKit API secret, Gemini API key, OpenAI API key, DB URL or room-admin credentials into browser, repo, client bundle, room metadata, subtitles or URLs. Supply `.env.example` placeholders and documented deployment secret setup only.
- Server validates authenticated gathering invite/cookie/session and active group membership for every token request. Use safe random room IDs, short token TTL, appropriate grants (join/publish/subscribe for *one authorized group*), and server-side disconnect/revoke old room participation during moves. Don't count an agent as one of eight humans.
- Implement bounded room participant count and join rate limiting; avoid open token minting with arbitrary room names. Restrict host/admin APIs.
- Voice processing requires affirmative notice and agreement. Separate recorded voice cloning enrollment requires explicit adult speaker consent, proof of voice ownership per provider, storage/deletion controls and no auto-enrollment. Never voice-clone by listening secretly to a conversation.
- Raw speech not recorded by default. Do not retain captions or raw audio unless separately opted into; redact logs; establish retention/deletion and visible provider disclosure. Handle EU privacy requirements honestly, including vendor processing geography/terms; do not claim EU-only processing without proof.
- Enforce real monthly/session AI budget/usage ceilings, session duration limits, idle shutdown, app-level session metering and host alerts. If cap is reached, cleanly stop translation and notify clients; no hidden accumulating bill.

## Validation: don't fake success

Build testable components and commit in milestones. Produce actual tests (unit, integration, manual device acceptance), not checkboxes alone. Mock provider streams for deterministic test of overlapping packets, session lifecycle, connection loss, routing and privacy. Have tests for user switching subgroup during a translated chunk and buffered captions/voice not leaking to old/new unauthorized listeners. Benchmark with real paid API and physical phones as soon as credentials/devices exist; if unavailable, MARK NOT TESTED.

Test matrix at minimum:
- 2 humans: Spanish/Polish uninterrupted 30s speech, first audio while source is speaking; same-language passthrough.
- 2 humans: 20-second speech plus 1-second interruption at 8s, both microphones remain live.
- 3 humans: Polish/Spanish/English multi-interruption; each listener correct target.
- 4 humans: two languages, random mute/reconnect, speaker focus; 2+2 private groups.
- 8 humans: mixed ES/PL/EN, Argentine/Colombian/Spain Spanish, 5+3 and 3+3+2 breakouts, switch back to Main, unauthorized token probes, talkovers, same-room mic bleed.
- iOS Safari and Android Chrome Bluetooth: mic route, output, echo, phone lock/unlock, switching Wi-Fi/mobile, disconnected headset; display unsupported/background restrictions clearly.
- Provider A/B with measured native->translated first audio, p50/p95, catchup lag, interruption onset, voice consistency, translation accuracy of names, slang, profanity, jokes, numbers, accents.
- Cost test confirms sessions shared per distinct target language and stopped on mute/switch/end; spending-cap enforcement.

When comparing models, DO NOT claim an official '95% accuracy' for Spanish–Polish or guaranteed voice cloning. Have native Spanish and Polish reviewers rank fidelity on pre-recorded consented gold-set clips and real sessions; do not evaluate only with WER or synthetic text.

## Milestone-by-milestone execution (actually ship)

**M0 Research/baseline:** inspect current upstream, license, dependencies, API docs, repo constraints. Write gap analysis and reproduce existing 2-person English/Spanish demo locally. Confirm Polish language code and paid API availability, source track identity and frontend Vercel deployment viability.

**M1 Truly streaming 2-person MVP:** one WebRTC stream per person, Polish↔Spanish, continuous both ways, audible before an uninterrupted 20+ sec monologue ends, speaker name in captions, mic/BT self-test, live status, safe server token issuing, usage meter. Deploy staging Vercel frontend + LiveKit agent if credentials provided. Provide actual URL and evidence ONLY IF deployed.

**M2 4-person and 8-person mixed language:** on-demand `(source, target)` sessions, same-language passthrough, independent speaker voices, no overlapping duplicate streams, three target languages; collect benchmarks and costs. Implement robust Bluetooth selection/warnings.

**M3 Natural interruptions:** simultaneous source translation and listener-side mixer with gentle ducking, >2 source focus controls, always-independent source streams and captions, deterministic mixer overlap tests.

**M4 Private breakout groups:** authoritative Postgres membership, role/invitation design, separate LiveKit media rooms, secure atomic switch, cleanup/stop, race-condition tests, privacy attack tests, arbitrary 8-user partitioning.

**M5 Production hardening and provider A/B:** OpenAI fallback behind toggle, synthetic failures, logs/metrics, abuse/rate limiting, mobile smoke tests, latency and cost measurements, security review, documentation, staging/prod deploy.

**M6 Optional voice replication:** only after core passes and real consenting users request it. Separate enrollment and verification, compare latency/quality to native live-preserved voices; may be disabled if it harms the fast path. Never present fictional cloning support.

## Deliverables (check all before claiming done)

- Working source in user's OWN repository, atomic commits/PRs, changed-file list and development changelog.
- Locally runnable steps from clean checkout, tested package/build/test/lint commands.
- Environment variable sample, secret placement table and no credentials committed.
- Vercel import/deployment steps and LiveKit Cloud agent deploy scripts; DB migrations and production config.
- M0–M5 demos; reproducible test report recording PASS/FAIL/NOT RUN; 2/4/8 physical-device status made explicit.
- Speaker-labeled audio + captions; private group isolation proof; latency and costs dashboard; provider status and budget guards.
- Link to staging and production ONLY if they actually exist; never invent URLs, tests, deployed state or credentials.
- Plain-language list of what does not work and limitations (Safari lock, Bluetooth duplex voice quality, concurrent audio intelligibility, voice drift, acoustic bleed).

## How to work in Codex

1. Read EVERY companion specification in numeric order plus `AGENTS.md` and check source docs in `14_OFFICIAL_REFERENCES.md` before editing code.
2. Start from repository code not from prose assumptions. Produce concise milestone plan, then IMPLEMENT milestone M0 and M1, execute checks and commit/PR the working code. Keep progressing through milestones where allowed; do not stop after design docs.
3. Do not ask the user to provide API keys in the chat. Provide secure instructions to configure them in Vercel/LiveKit/local `.env` files.
4. If no Vercel/LiveKit/DB credentials or deployment permissions are available, deliver fully runnable code and exact deployment commands while clearly reporting deployment blocked. Do not fabricate an online app.
5. Never sacrifice stream continuity and security for cosmetic UI, voice-cloning hype or an apparently polished static demo.

**Definition of done:** ordinary phones + Bluetooth headsets can actually carry a private up-to-eight-person English/Polish/Spanish gathering in which interpretations begin DURING original speech, people can interject, distinct speaker streams remain attributable, participants can enter private sub-conversations, and the service can be deployed and operated at a known measurable cost. Anything less must be labeled prototype/partial.



---

# SOURCE FILE: 02_PRODUCT_REQUIREMENTS.md

# User experience and requirements

## Mobile join flow

1. Host taps **Create gathering**; QR and short share link appear. Gathering private by default.
2. Invitee opens link, enters display name (e.g., Ian, Kamila), selects their speech + listening language and optionally regional Spanish profile (Argentina, Colombia or Spain), chooses microphone/output, passes headset test.
3. Each adult accepts live AI speech processing notice; translation activates only then.
4. All participants see authorized gathering presence (without private group membership disclosure), their current group's names and icons, live input activity, translation status, elapsed time and spending estimate.
5. Everyone speaks in their normal language. The app delivers translations in each listener's chosen language and avoids mixing original/translated duplicate audio.
6. Tap any speaker tile for source text, translated text, volume/mute or 'focus voice'. Subtitles can be closed.
7. Host can invite, remove, mute and end the gathering. Group creators can manage their own authorized subgroup memberships. App closes idle translation sessions automatically.

## Private groups inside one gathering — user experience

The gathering is the permanent eight-person invitation/presence container, not the only audio conversation. All eight can be connected while dividing naturally into smaller, fully independent conversations of any size: 5+3 (living room and outside), 4+4, 3+3+2, four pairs, etc. The main group is always one-tap accessible by an admitted participant. Any person can create a private conversation, invite specific participants, and accept/decline invitations. The user can see **You are talking with [names]**, the active subgroup, and switch groups without signing back in, reopening the invite, or pairing earbuds again. If they move, no media or captions from their previous group continue playing. Any private group is invitation-only by default; group metadata must not leak to nonmembers.

The three-language AI pipeline, different voices for different speakers, continuous low-delay translation, short overlapping interruptions and user volume controls all apply **within each conversation group**. No cross-group broadcast or monitoring. Use server-enforced group media isolation and actual participant-scoped LiveKit permissions: client mute/subscription filters are insufficient. Full protocol in `06_BREAKOUT_PRIVACY_SPEC.md`.

**Disclosure:** Server isolation prevents deliberate cross-group routing but cannot prevent nearby human speech being picked up acoustically by a headset microphone; actual audio goes to the AI processing provider under the stated consent terms.

## Essential experience: translated speech starts while the person is still speaking

**The user will reject any app that waits until a speaker stops talking before their translation starts.** Real-time means streaming audio-to-audio, not transcription followed by end-of-sentence TTS. All participants speak naturally; a person listening in another language hears the beginning of the translated thought after a short rolling delay, while the speaker keeps talking. No required microphone tap, turn-end button, pause or explicit handoff.

Example: a Spanish speaker says "Hola, me llamo Ian Luca, soy de Argentina..." continuously. A Polish listener should begin hearing "Cześć, nazywam się Ian Luca..." before the source sentence or thought is finished. Quality-first incremental phrase grouping is fine; word-by-word literal output is NOT the objective, and word order sometimes demands a slight wait for context.

UI should show a compact live status: **Live / Translating (~N s behind) / Delayed / Reconnecting**, with metrics calculated from actual stream timestamps. Any viewer may temporarily emphasize one translated speaker if several people talk simultaneously; never force sequential speaker turns globally. For low-latency mode, prioritize streaming over exact cloned voices. See 04_STREAMING_LATENCY_SPEC.md.

## Language settings

- English
- Polish
- Spanish — Argentina
- Spanish — Colombia
- Spanish — Spain

IMPORTANT: all Spanish regional variants map to the model's `es` target in default real-time mode; regional preferences are metadata used for UI, accuracy evaluation and any experimental TTS accent mode. Never advertise guaranteed accent-specific output in the Gemini 3.5 Live Translate mode.

## Voice personalities

- Default: native dynamic voice-preservation and one identifiable voice track per real speaker.
- UI must show spoken speaker's NAME (not just language) during playback.
- Preserve perceived voice presentation, timbre, pitch and style when possible. Voice adaptation may fail; provide 'voice may change' note.
- Advanced experimental: explicit speaker-selected synthetic voice, if the chosen synthesis backend supports it; could be less natural but more reliably distinct.
- Opt-in verified replication: short clean enrollment recording, separate consent recording/verification and immediate ability to delete; adds cost/latency. Only expose once a backend exists; a nonfunctional toggle is unacceptable.

## Important physical limitation

Eight people in one room produce speaker leakage into one another's microphones. Earbud microphones do not reliably isolate speech perfectly; noise suppression and push-to-talk fallback are important. Overlapping voices may be audible but difficult to cognitively follow. Phone screen lock and browser background audio are platform dependent.

## Required natural interruptibility

The app is **full-duplex and multi-speaker**, not an interpreter that requires the other person to stop. During a long Spanish, Polish or English utterance, other participants may interrupt with brief comments; translation of the reaction should play promptly on the first speaker's headset in the interrupter's distinguishable translated voice. Two voices may briefly overlap, with gentle listener-side ducking and separate captions. Longer competing conversations need user-controlled focus/auto balance, not forced global turn-taking or silent dropping of speech. See 05_INTERRUPTS_AND_OVERLAP.md.



---

# SOURCE FILE: 03_TECHNICAL_ARCHITECTURE.md

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



---

# SOURCE FILE: 04_STREAMING_LATENCY_SPEC.md

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



---

# SOURCE FILE: 05_INTERRUPTS_AND_OVERLAP.md

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



---

# SOURCE FILE: 06_BREAKOUT_PRIVACY_SPEC.md

# Breakout groups, movement, and private audio — implementation & acceptance spec

## Product definition: one gathering, many independent live conversations

The eight participants **join a single gathering** using a shared invite. They remain members of that gathering until leaving. At any time they can move between **independent conversation groups** of arbitrary size, provided the total gathering membership never exceeds eight. One gathering can be partitioned 5+3, 4+4, 3+3+2, 2+2+2+2, etc. The default main group is one conversation group, NOT a permanent audio feed everybody hears regardless of where they go.

Example: five people continue in `Living room` while three move to `Outside`. The outside three hear ONLY audio (translated or original) from the outside group. The living-room five hear ONLY their own group's audio. Members remain connected to gathering-level presence and can return to the main group or join an invited group without creating accounts, exchanging new URLs, or rescanning the gathering QR code.

This is a **high-priority release gate** alongside streaming, interruptions and privacy. Users must not have to end the gathering to form a breakout group.

## User-facing behavior

- Main gathering link admits up to 8 people, with existing speaking language, listening language, Spanish locale, headset configuration and distinct speaker voice identity saved per participant.
- Screen shows **Your conversation: Living room (5 people)** and the current group members by name. A compact **Switch conversation** control opens the group menu.
- Any participant may create a group: name it (e.g. `Outside`, `Kitchen`, `Private chat`), choose invitation-only membership (default), and invite selected participants. For user comfort, invitations show the inviter, group name and target members; no automatic transfer without acceptance.
- Invitee can accept, decline, or remain in current group; accepting makes them leave their old group's live audio and enter the new group's audio. Provide visible confirmation **You are speaking only with: [names]**.
- Any participant can return to the shared **Main conversation** with one tap. The main group is accessible to any admitted gathering participant unless the gathering has ended. Additional groups are private/invitation-only by default.
- Group members can send invitations and the group creator can remove participants. Changes must be authoritative and affect translation streams and captions, not just a local mute state.
- No need to end/recreate gathering on switching. Preserve headset and language settings. Provide short **Switching... / Connected** feedback during media rejoin. Seek a fast transition, but do not promise seamless or interruption-free media across group changes when provider sessions/WebRTC rejoin are needed.
- Audio delivery within each group must continue to be **continuous**, low-lag, full duplex, and allow brief translated interruptions in a different speaker's voice. Global mixing across groups is NEVER allowed.
- A participant is in **exactly one active audio conversation** at a time for MVP; optionally they can be in a silent waiting/lobby state. Do not implement background eavesdropping on several groups simultaneously.
- When leaving, immediately stop outgoing microphone publication to the old group and unsubscribe/stop playback of its incoming tracks; clear private captions and any queued translated audio from its UI. Do not let a few stale seconds of old-group speech play after switching.
- UI may show group sizes and invitations, but avoid revealing private membership, titles, transcripts or speaker activity to people not authorized for that group. Use neutral labels for private groups visible to nonmembers, or hide them entirely.

## Architecture and privacy boundary (mandatory)

Keep **gathering membership/presence** separate from **audio conversation group membership**. The preferred robust MVP architecture is **a control-plane gathering with one distinct LiveKit media room per active conversation group**. Do not place everybody on one LiveKit room with only client-side mutes/filters and claim groups are private.

- Backend stores `gatheringId`, `participantId`, `groupId`, active `membership`, invitations, roles and session epoch/version. Control plane manages authenticated gathering presence and group transitions.
- Issue short-lived LiveKit media room tokens scoped to the participant's *current authorized group only*. Enforce group membership and publish/subscribe permissions server-side. Do not expose other groups' credentials to unauthorized clients.
- On switch: authorize target group -> revoke/expire or disconnect prior media-room participant and cancel old translation subscriptions/jobs -> stop mic publication and playout locally -> join target group's media room -> publish mic and subscribe to authorized original/translation tracks. Ensure old room receives no new mic frames once the switch is confirmed. Handle rollback safely if target join fails (never publish into both groups concurrently).
- A single person must not hold two active group media memberships. Use serializable state transition/epoch to avoid stale tabs, delayed token response, rapid back/forth movement, mobile reconnect races and replay of expired credentials.
- Translation stream keys **must include group identity**: `(gatheringId, groupId, speakerParticipantId, targetLanguage)`. Workers subscribe only to tracks of authorized members in their media room, and publish translated tracks and subtitles only to that same group. No cross-group forwarding, even if the same language target exists in several groups. Release resources for empty groups and stop generating outputs when nobody in that group requires a target language.
- Captions, speaker labels, optional ephemeral transcripts, mixer inputs, voice-profile settings and captions history remain scoped to currently authorized group. Clearing local state is additional to, not a replacement for, server-side group isolation.
- Avoid audio recordings and persisted transcripts by default. Keep diagnostics aggregated/redacted. All participant voice processing still happens via chosen AI service and infrastructure: **private from other groups does not mean end-to-end private from the AI provider**. Clearly disclose this to participants.
- People are physically near one another. A headset mic can unintentionally capture voices from a nearby group, which is an **acoustic limitation** even with server-side group isolation. Require headset checks, mic positioning, noise suppression and an optional manual mic mute / push-to-talk fallback. Do not promise the app can eliminate ambient speech leaking through someone's microphone.
- On an unauthorized attempt to subscribe/join or fetch captions from another group's media room, reject **on the server**, not merely by hiding UI. Avoid leaking group metadata through room APIs, invitations or socket broadcasts. Consider abuse (stolen invite, stale session, deep link reentry, privilege escalation) and test it.

## UX transition and quality goals

- Target one or two user taps to move to a group, once invited; no new link, login, app restart, language reconfirmation or headset re-pairing.
- Make media switch measured: time from accept/return action to first audible authorized live audio. Aim for a quick switch under good conditions; do not assert hard sub-second continuity without physical testing.
- Source speaker identity, unique translated voice and regional language preferences must persist across groups; never swap people or voices when groups split/merge.
- Existing live streaming/interruption performance requirements apply **independently per group**.
- Group-local translation work should use no more active source-target sessions than demand warrants. Do not keep all 8 people's translation workers broadcasting in a global main group when that group has shrunk to 5.

## Required manual and automated tests

1. Connect 8 phones with headsets. Divide 5 `Living room` + 3 `Outside`. Speak simultaneously in Polish, Spanish and English in both groups. Verify each listener receives ONLY translations/original streams from their active group, including subtitles and identifying voice.
2. Split to 4+4, 3+3+2 and 2+2+2+2. Ensure all voice identities persist and nobody must reconnect to the gathering.
3. Have one invited person switch from `Outside` to `Living room` mid-monologue. Prove old audio and captions stop, new ones start, and the microphone is never published to both groups. Test a brief translated interruption after rejoining.
4. Attempt unauthorized entry and subscriptions to another private LiveKit room by guessing a group ID, replaying old tokens, calling subscription APIs, or rapidly switching from two phone tabs. All must be denied server-side; no voice/captions leak.
5. Test declined invite, room owner removes guest, last member leaves, main group becomes temporarily empty, one member loses network mid-switch, host ends gathering, and headset drops during switch.
6. Confirm group rename/create/destroy and visibility rules; do not display private members or conversation activity to outsiders.
7. Test two groups sitting within microphone range to reveal acoustic bleed; document how much physical noise suppression helps and when only moving away or push-to-talk provides useful privacy.
8. Measure switching latency, translation streaming latency, interrupted-speaker delay and API cost per active group. Never report test results that were not performed with actual phones and headsets.

## Explicit non-goals for MVP

- Cross-group broadcast/eavesdropping; one person listening to several groups simultaneously.
- Perfect secrecy from someone who can physically overhear a group or whose headset microphone captures nearby people.
- Guaranteed uninterrupted translated audio during a WebRTC/provider switch or guaranteed zero latency.
- Recording, searchable private transcript archives, hidden invitations or automatic geolocation-based group assignment.



---

# SOURCE FILE: 07_SPEAKER_VOICES.md

# Speaker identity, recognizable voices and optional replication

## Nonnegotiable product outcome

People listening to a translation need to know WHO spoke, especially when brief interruptions overlap. Never mix all human sources into one anonymous AI voice track. Voice identity and speaker attribution have separate meanings:

1. **Guaranteed by our software, if correctly implemented:** each human source has a unique stable `participantId`, one input media track, speaker-labeled caption events, and their own translated output tracks, with names and focus/volume controls.
2. **Best effort by model, not guaranteed:** generated speech may mimic source timbre, pitch, style and voice presentation. The model may drift and may not preserve a person's pitch/voice characteristics consistently.
3. **Exact voice cloning:** separate experiment requiring *explicit adult voice-owner consent*, a clean reference clip, consent verification, voice storage/deletion UI and potentially a *different* TTS engine that may add latency. Do not treat it as a configuration flag on streaming Gemini Live Translate.

## Human-friendly voice presentation

The user wants recognizably different translations for the man speaking and the woman speaking. Implement **self-selected** voice preferences and stable participant colors/names rather than assigning sex or gender from an audio classifier. For example `preferred_voice_presentation` can be 'lower pitched', 'higher pitched', 'natural/model adaptive', or 'no preference', but SHOW a control only when the selected provider supports it. In Gemini/OpenAI dedicated translation API the choice of synthetic voice is not necessarily exposed. If unavailable, default to model-adaptive translated voices; make limitations clear.

Support source speech + accent preferences: English, Polish, Spanish Argentina/Colombia/Spain. `es-AR`, `es-CO`, `es-ES` are not evidence that the live API can synthesize reliable region-specific accents; language code `es` is used unless official docs support more.

## Provider-specific notes (verify before implementation)

- **Gemini 3.5 Live Translate:** purpose-built streaming translation, continuous output, model voice preservation best effort. Google acknowledges occasional changes in voice characteristics. Model is preview. API docs: https://ai.google.dev/gemini-api/docs/live-api/live-translate
- **OpenAI `gpt-realtime-translate`:** continuously streams translated audio with dynamic voice adaptation and separate transcripts. Official cookbook explicitly says it **does not support custom voice selection parameters** at present. Therefore never invent `voice_id` for this dedicated model: https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide
- **Google voice replication (different API):** `POST /v1beta/voices`; Gemini 3.8 Flash TTS / Flash-Lite TTS supports verified voices, but this is not a replacement for the live interpreter. Documented input reference clip ~10–30 seconds plus consent recording by same adult owner. Verify storage/TTL and deletion docs: https://ai.google.dev/gemini-api/docs/voice-replication

## Privacy and safety requirements

- Voice replication OFF by default. No automatic enrollment from gathering audio. One explicit opt-in per speaking person; separately record clear informed consent and ensure provider terms/eligibility are met.
- Never let a host clone another person's voice without that person's direct confirmation.
- Ensure user can revoke, delete voice IDs/keys with their provider, and delete any local reference/consent clips. Retain nothing by default.
- Disclose clearly in UI that output is generated by AI and may sound wrong, be delayed, or occasionally use the wrong vocal character.
- If voice replication increases 20-second-monologue first-audio latency, interruption delay or rolling lag materially beyond release gates, keep the fast translation as the default and offer experimental richer output ONLY by explicit choice.

## Acceptance tests

- Four sources speaking English/Polish/Spanish with separate names, voices and tracks; each captions source ID and target language.
- Two voices overlap for 1–3 sec; names are correct and no speech from another source is attributed to the wrong person.
- Model switches to inconsistent voice: UI still preserves name/speaker identity, and event is logged as voice-identity quality failure.
- Test adult opted-in cloning with explicit consent and compare 20+ sec streaming first audio and fidelity against native streaming. If voice cloning isn't implemented, say NOT IMPLEMENTED, not 'Available'.



---

# SOURCE FILE: 08_MOBILE_AND_BLUETOOTH.md

# Mobile phones, Bluetooth microphone/headset and best practical setup

## Recommended real-life hardware

- Every person: one Android or iPhone with stable Wi-Fi or data and one Bluetooth headset with a microphone. Prefer ear-hook or boom / close-to-mouth microphone for crowded rooms. Expensive noise-canceling MUSIC earbuds do not always provide strong microphone voice isolation.
- Participant can use one earbud for situational awareness. App must still deliver mono-compatible translations; no hard channel routing needed.
- Charge phones, allow microphone permission, connect Bluetooth before entering gathering, keep browser page foreground when testing. Set headset as the **input** device where available; require loopback test confirming which mic was actually used (the phone may silently select internal mic).
- Bluetooth call/duplex mode often reduces audio quality versus listening to music; assess microphone speech separately from speaker playback. No app can force every phone/browser to obey a requested device route.

## Web first; native app if needed

- Start with Vercel-hosted HTTPS installable PWA / Next.js browser experience. On Android Chrome, test `getUserMedia`, `enumerateDevices` after permission, default audio source selection, autoplay after a user gesture, headset reconnect and background tab behavior. On iOS Safari, test mic/audio routing, autoplay restrictions, switching apps, screen lock and incoming calls.
- A **web PWA cannot guarantee** continuous microphone capture or playback with a locked screen on all iOS/Android/browser combinations. Do NOT claim phone-in-pocket/locked-screen reliability until real device tests pass. If it fails: build native iOS/Android clients with LiveKit mobile SDKs and appropriate background-audio permissions while retaining the same backend.
- Vercel isn't hosting persistent WebRTC workers. The browser connects directly to LiveKit Cloud media infrastructure, with server route endpoints minting validated short-lived tokens.

## Same-room acoustic challenges

Eight nearby headsets = up to eight mics picking up one human's voice; separate digital tracks do not automatically mean clean speaker separation. Risks:
- Phone/headset mics capturing a person sitting nearby (duplicated/false translated voice from several users)
- Translated headset playback feeding back into another mic (loop of translated speech)
- Physical noise/musical background, group laughter and people interrupting each other

Mitigations (verify, don't oversell): directional/close-talk headset mic; WebRTC AEC/NS/AGC as appropriate; LiveKit/Krisp denoise if supported; per-source audio level, duplex diagnostic, mute button, provider-side source attribution, short duplicate-speech suppression heuristics with safeguards. Test false cancellation of quiet interjections. PTT should be optional LAST-RESORT fallback, not normal behavior.

## Essential practical mobile test cases

| Test | Android Chrome | iPhone Safari |
|---|---|---|
| Secure join via URL and QR | Required | Required |
| Bluetooth microphone genuinely selected | Manual verification | Manual verification |
| Translated audio heard in same headset while mic works | Required | Required |
| Screen on / page foreground 30 minutes | Required | Required |
| Screen locked 5+ minutes | Investigate/measure | Investigate/measure |
| Phone call interrupts room then rejoin | Required | Required |
| Wi-Fi -> mobile network switch | Required | Required |
| Bluetooth drop/reconnect without wrong mic or echo | Required | Required |
| Eight devices physically close, simultaneous commentary | Required | Required |

Do not record PASS unless executed on real devices. Document make/model, OS version, browser, Bluetooth headset and reliability. Failure on locked-screen web client should trigger native-app decision, not wishful claims.



---

# SOURCE FILE: 09_TEST_MATRIX.md

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



---

# SOURCE FILE: 10_DEPLOYMENT_AND_ENV.md

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



---

# SOURCE FILE: 11_SECURITY_COST_AND_OBSERVABILITY.md

# Security, cost metering, privacy and observability

## Authorization — hard requirements

All eight humans have a single gathering identity. A participant receives media authorization for at most their one ACTIVE conversation group. Authoritative state on trusted server (e.g. managed Postgres): gathering ID, owner/admin, invited/accepted participant, expiry, group IDs, group membership, activeGroupId, activeGroupEpoch, revocation time.

Before minting media token, server checks (1) invitation/cookie session, (2) not kicked/banned, (3) this active group and epoch, (4) under eight humans, (5) cost budget and session TTL. Generate cryptographically random LiveKit room IDs; don't trust caller-provided room. Use short token TTL and explicitly remove participant from old room at switch; previous token may survive for a limited time unless invalidation is enforced. Validate actual LiveKit permissions carefully and try malicious direct WebRTC join with an old token. Prefer deny over cross-group leakage.

The client can display a global gathering presence list but not private-group audio or private group metadata to nonmembers. Do not let translated source, replay, captions, ephemeral buffers or diagnostics cross group boundaries. Treat logs/traces containing audio/transcripts as sensitive.

## Consent and data retention

- Before mic starts, explicit participant consent to third-party AI processing, clear server/media supplier disclosures, policy version and privacy link. Don't store raw audio by default. Captions transient by default, unless separately opted into storage.
- Speech recognition/AI providers may process audio in other jurisdictions. Do not assert EU-only processing without contractual and infrastructure verification. Treat this as a product privacy review; EU users may require GDPR notices, appropriate legal basis, processor contracts and deletion workflows.
- Voice replication requires entirely separate opt-in and verified adult speaker consent. Reference/consent clips should be temporary and deletable. Don't enroll or copy voices without consent. Speaker may disable or delete clone.
- Media group authorization boundaries do not stop audible acoustic leakage in the physical room (another person's headset mic can pick up nearby group speech).

## Costs — dynamic rather than false precise quotes

Cost depends on **number of distinct simultaneous `(source speaker, target language)` streams** per active media group, **not** eight listeners times seven speakers. For three languages and eight active source users, maximum illustration is 8 x 2 = 16 source-target streams when *each source* requires both of the other target languages. Demand tracking turns off streams when no listener needs their translation.

Pricing changes. Compute cost using current official Gemini rates and separate OpenAI rates, with duration and generated-audio usage as published. Include LiveKit SFU minutes, worker compute/agent session use, Vercel hosting, database and network. Don't hard-code approximate marketing price or claim spending caps from provider alone. Build estimate meter from observed active sessions and output length and reconcile with actual provider bills.

Host can set e.g. `USD 50` session cap and `USD 200` monthly cap, configurable. Pause new translation sessions when cap reached; show notice in each room and keep optional untranslated conversation if policy permits. Meter: `gathering`, `mediaGroup`, `speakerId`, `targetLang`, `provider`, `startTime`, `endTime`, input audio duration, output audio duration/tokens, failure status; no raw audio in logs.

## Measurements that MUST be recorded

- Browser capture started, first actual speech onset, worker received first PCM, model sent first translated chunk, user-facing output audible — do not confuse connection setup time with speech-to-speech latency.
- p50/p95 first-audio, uninterrupted 20–60 sec rolling backlog/lag, 1-second interjection latency and lost/interrupted words, dropped/underflow chunks, reconnect duration.
- Success/failure by each of six directed language pairs and `es-AR`, `es-CO`, `es-ES` input; actual bilingual reviewer rating of accuracy, humor/slang/names/dates/numbers.
- Each media group membership move, authorization-denied event, old-token invalidation, old-track teardown; no captions/voice from old group heard after move.
- Per-headset mic isolation and false double-translation due to same-room acoustic bleed.
- Voice character consistency by source with participant consent; don't store identity biometrics in analytics.

## Alerts and throttling

Implement quota alarms (minutes & USD forecast), rate-limited new gatherings, short-lived sessions, worker idle shutdown, admission control and backpressure. Expire stale rooms; ensure worker translation sessions close when source leaves/mutes/moves group. Warn before budget limit; enforce stop independently from UI. If provider goes down, silence translated tracks and show error clearly rather than making people believe translations are active.



---

# SOURCE FILE: 12_MILESTONES_AND_REPORTING.md

# Build roadmap and completion report format

## Exact milestones

**M0 — Baseline:** Fork and inspect upstream. Verify license, install dependencies, run existing 2-person translation under current API version, document changes from assumptions. CI lint/build/tests green.

**M1 — Working 2-user streaming MVP:** Spanish ↔ Polish, independent real microphones, separate translated tracks, simple invite, safe signed tokens, captions with speaker name, live-audio start before source speaker stops. Start with Google only. Local and staging if credentials are configured. Real 2-phone test if phones are available.

**M2 — 8-human mixed language gathering:** English, Polish, Spanish with AR/CO/ES preferences; source/target demand routing; compatible Bluetooth path, phone device test, same-language passthrough, network reconnection, costs.

**M3 — Overlap:** Full-duplex simultaneous speech, independent speaker streams, short interjections heard without waiting, gentle mix/duck, focus speaker, no global floor or accumulation of backlog.

**M4 — Breakouts:** Postgres authoritative group membership, invitation-only private subgroups, separate secure LiveKit media rooms, group switch, old-token invalidation, cleanup, privacy exploit tests and valid partition cases.

**M5 — Production operations:** Vercel UI, LiveKit agent worker, environment docs, logs, budget, quotas, error states, provider swap experiment, phone test reporting and security review.

**M6 — Optional:** Voice owner-verified cloning experiments, only if voice fidelity and latency test results justify it. Native mobile Android/iOS clients if browser background restrictions are too severe.

## A complete sprint/PR must contain

1. What code changed and why, including file list and PR link/commit SHA if GitHub connected.
2. Tests actually run, with pass/fail and raw measurable results. Write NOT RUN for device tests without devices.
3. Live URL only if deployed and opened/tested; otherwise write 'not deployed' with blocker and exact commands.
4. Reproduction steps for normal user and host, environment variables required (names only), credentials never printed.
5. Any new compatibility/voice/privacy limitations documented, not hidden.
6. Next release gate and what remains unfinished.

## Acceptance matrix

| Scenario | Success criteria |
|---|---|
| 30-second uninterrupted Spanish monologue | Polish translation begins before sentence ends; measured delay and rolling lag |
| Polish interrupt at second 8 | Spanish listener hears translated 1-second interjection while still speaking; main mic still publishing |
| Eight users, 3 languages | Each source's output delivered to correct authorized language listeners; no double audio |
| Five living room, three smoking outside | Distinct groups only hear their own media + captions; no cross-group tracks |
| Move participant | Previous media stops; token reuse into unauthorized room denied; queued captions cleared |
| One Polish speaker, three Spanish listeners | One reused Polish->Spanish translation session, not three paid sessions |
| Voice differentiation | Per-speaker tracks and captions stable; actual AI voice preservation verified or marked unreliable |
| Phone lock | Real device recorded PASS or limitation shown; not assumed browser always works |
| Cost cap | Translation pauses/shuts down at enforced cap; meter matches real usage closely |
| Disconnect/rejoin | Human rejoins authorized group after transient network loss, without stale-stream leak |

## Reporting format for Codex

```text
STATUS: [CODE WORKS LOCALLY | DEPLOYED STAGING | DEPLOYED PROD | PARTIAL]
Milestone: M0/M1/... 
Files changed:
Commands + test outcomes:
Real-device tests: [performed device list | NOT PERFORMED]
Translation provider + model id:
First translated audio latency p50/p95:
Interruption latency p50/p95:
Breakout privacy tests:
Known unresolved problems:
Live URL: [verified URL | NOT DEPLOYED]
Estimated cost/hour and cap behavior:
Next actionable milestone:
```



---

# SOURCE FILE: 13_REPO_HANDOFF.md

# GitHub and Codex operating instructions

## Easiest route: Codex cloud on your GitHub repository

1. Open https://github.com/livekit-examples/gemini-live-translate and use **Fork** to create a repository in your OWN GitHub account. Leave the upstream repository untouched. If fork isn't available, import source under correct MIT attribution and disclose it.
2. Extract this ZIP. Commit ALL `.md` specification files and the `ENV_EXAMPLE_*` placeholders in a `docs/codex/` folder in your fork, but keep root `AGENTS.md` so Codex sees the operating rules. Do NOT push `.env.local`, API keys or phone recordings.
3. Open https://chatgpt.com/codex, select your GitHub fork. The GitHub connection in normal ChatGPT does not automatically guarantee Codex has access; approve it if prompted.
4. Open a new coding task and paste the FULL contents of `01_MASTER_CODEX_PROMPT.md`. Ask Codex to perform M0+M1 immediately, push branch/PR, run automated checks, and report actual behavior and blockers.
5. Review PR and decide whether to merge, then ask Codex to continue with M2/M3/M4; don't call the job complete because screenshots or UI look good.
6. Create LiveKit Cloud and Google AI Studio keys. Add them only to secure environment/Secrets areas; never paste sensitive values into the Codex task.
7. Once working, connect fork to Vercel and deploy worker on LiveKit Cloud. Test real end-to-end audio on phones.

## CLI route (if using local Codex instead)

```bash
# Clone YOUR fork URL, not the original repository, then copy in docs.
git clone https://github.com/YOUR-USER/eight-person-live-translator.git
cd eight-person-live-translator
# Put this pack's specs in docs/codex, and AGENTS.md at repo root.
# Open this folder with Codex CLI/IDE and give it 01_MASTER_CODEX_PROMPT.md.
```

Commands for install/test are documented by the upstream repository. Codex should preserve dependency pinning and provide reproducible steps for your machine.

## Suggested first message to Codex

> Read all docs in `docs/codex/` and root `AGENTS.md`. Execute the full `01_MASTER_CODEX_PROMPT.md`, starting immediately with M0 and M1. Don't respond with only a plan. First reproduce upstream, then implement and validate 2-person Polish/Spanish continuous streaming translation, with a secure path to deploy Vercel + LiveKit. Create commits/PR with tests and a candid status report. Proceed to later milestones if possible.

## If Codex can't deploy

It can still implement the actual application code and tests. Missing Vercel/LiveKit authorizations or Google billing credentials are **blocking prerequisites** for a public working deployment. Report blockers exactly; never invent a live domain.



---

# SOURCE FILE: 14_OFFICIAL_REFERENCES.md

# Primary technical sources — reviewed 2026-10-27

1. LiveKit eight-person MIT starter, Next.js + Python Agent and deployment quickstart: https://github.com/livekit-examples/gemini-live-translate
2. Google Gemini 3.5 Live Translate: https://ai.google.dev/gemini-api/docs/live-api/live-translate
3. Gemini Live Translate model card: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview
4. Official Gemini pricing (verify before billing): https://ai.google.dev/gemini-api/docs/pricing
5. OpenAI realtime translation architecture and streaming protocols: https://developers.openai.com/api/docs/guides/realtime-translation
6. OpenAI translation model: https://developers.openai.com/api/docs/models/gpt-realtime-translate
7. OpenAI realtime translation cookbook, dynamic voice adaptation & lack of voice selection: https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide
8. Google voice replication, independent TTS, adult-speaker consent: https://ai.google.dev/gemini-api/docs/voice-replication
9. LiveKit Agent deployment (containers and cloud): https://docs.livekit.io/deploy/agents/
10. LiveKit Cloud console: https://cloud.livekit.io
11. Google AI Studio and keys: https://aistudio.google.com
12. Vercel deploy: https://vercel.com
13. OpenAI developer API: https://platform.openai.com

## Confirmed distinctions

- The Google dedicated model streams translation while a person is talking. Input 16kHz PCM16, output 24kHz PCM16; documentation recommends ~100ms chunks.
- The OpenAI dedicated translation model is NOT a chat/assistant; WebRTC or WebSockets to `/v1/realtime/translations`, no `response.create`. WebSocket requires 24kHz PCM16 in ~200ms chunks and emits continuous translated audio; official cookbook says no custom voice selection.
- The upstream LiveKit example actually has 8-participant rooms, demand-driven per-(speaker,target-language) sessions, separate tracks and a Python agent. It is a starting point, NOT a validated app with your breakout security or 8-device hardware test.
- Google voice replication via Gemini 3.8 TTS is SEPARATE from Gemini 3.5 Live Translate and requires clean reference + explicit consent by adult voice owner. Do not claim exact voice replication is built into streaming interpreter.
- A Vercel site cannot keep a Python translation worker alive for 8 concurrent microphone streams with typical stateless functions. LiveKit Cloud Agents is the recommended long-running worker.
- Preview API names, limits, quotas, dialect support and prices may change. Codex must check docs in its actual execution environment, and preserve compatibility in pinned versions.


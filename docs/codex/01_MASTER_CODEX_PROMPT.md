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

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

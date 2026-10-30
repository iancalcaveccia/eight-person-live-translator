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

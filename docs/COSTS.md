# Running costs

List prices checked 2026-10-30. These are **estimates**; reconcile with real
invoices. The app meters its own usage and enforces caps (per gathering, per
day, per month) independently of the providers.

## What drives the AI cost

One translation session exists per **(speaker, target language)** in a group,
shared by every listener who wants that language. Same-language listening costs
nothing. With English, Polish and Spanish all present in one group, each speaker
needs at most 2 sessions → at most **16 sessions for 8 people**.

Gemini bills input audio sent and translated audio produced:

- input: $0.0053 per minute of audio sent
- output: $0.0315 per minute of translated audio

The worker only streams audio to Gemini while it detects speech (plus a
pre-roll and a hang-over so beginnings and endings are not cut), so silence is
not billed as input. Output only exists while someone is being translated.

## Example: 8 people, 3 languages, one table, 3 hours

Assume conversation is active most of the time and, on average, ~1.2 people are
talking at any moment (overlaps and pauses included):

| Item | Estimate |
|---|---|
| Speech minutes per hour (all speakers) | ~72 |
| Translated output minutes/hour (×2 targets) | ~144 → **$4.54/h** |
| Input minutes/hour sent (×2 sessions, + ~25 % gate overhead) | ~180 → **$0.95/h** |
| **Gemini total** | **≈ $5.5 per hour ≈ $16 for 3 hours** |
| Worst case: 16 sessions streaming nonstop, gate disabled | 16 × 60 × ($0.0053 + $0.0315) ≈ **$35/h** |

Splitting into groups usually *reduces* cost (fewer target languages per group).

## Infrastructure

| Service | Plan | Cost |
|---|---|---|
| LiveKit Cloud | **Build (free)**: 5,000 WebRTC min, 1,000 agent session min, 5 concurrent agent sessions, 100 voice-isolation min, cold start 10–20 s | $0 |
| | **Ship**: warm agents (no cold start), 150k WebRTC min, 5,000 agent min, 20 concurrent sessions | from $50/month |
| Vercel | Your team is already on **Pro** | existing plan |
| Postgres | Neon free tier via Vercel Marketplace (0.5 GB) is plenty | $0 |
| OpenAI (optional backup) | $0.034/min | only when used |

A 3-hour, 8-person dinner uses ~1,440 WebRTC minutes and ~180 agent session
minutes per group room — inside the free LiveKit tier, but the free tier's
10–20 s cold start delays the first translation of a gathering. Upgrading to
Ship is recommended for real use; it is a paid plan, so it is **your decision**
and was not done automatically.

**Typical monthly total** for a few dinners a month: Gemini ~$15–20 per long
dinner + LiveKit $0–50 + Vercel (existing) + DB $0.

## Caps (defaults, configurable on Vercel)

- `MAX_AI_SPEND_PER_GATHERING_USD=50`
- `MAX_AI_SPEND_MONTHLY_USD=200`
- `MAX_AI_SPEND_DAILY_USD` (unset = no daily cap)

At 80 % of a cap everyone sees a warning; at the cap the worker closes every
provider session within ~2 s and listeners hear people in their original voices
only. Sessions also close when a speaker mutes (after a 10 s grace), leaves,
switches groups, or when a room is empty for 30 s.

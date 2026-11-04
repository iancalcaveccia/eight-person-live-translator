# Real-device test plan (manual)

Everything here is **NOT RUN** until a person performs it with real phones and
headsets. Record make/model, OS version, browser, headset, network, date and the
result for every row. The app's **Settings → Live measurements** panel shows the
measured delays; use **Copy** of the numbers into this table.

## Setup

- Production or staging URL with real LiveKit Cloud + Gemini keys.
- At least 2 phones (1 Android Chrome, 1 iPhone Safari), each with a Bluetooth
  headset with microphone. For later rows: 4 and 8 phones.
- Recommended: record the session with a separate camera (with everyone's
  consent) to verify "translation starts before the speaker stops".

## M1 — two people

| # | Test | How | Pass when |
|---|---|---|---|
| 1 | Join via QR and link | Host creates; guest scans QR | Guest reaches the room; no login needed |
| 2 | Headset mic really used | Join flow → Check my headset → Record & play | Playback sounds close/clear (not phone mic) |
| 3 | 30 s Spanish monologue → Polish listener | Speaker talks nonstop ≥ 30 s | Polish audio starts **while** Spanish continues; note "Speech → your ears" p50/p95 |
| 4 | Reverse (pl → es), and en ↔ pl, en ↔ es | Same | Same |
| 5 | Same-language passthrough | Both choose Polish | Original voice heard, status "Everyone here speaks your language", cost stays $0.00 |
| 6 | Interjection | A talks 20 s; B says "Co?! Serio?!" at ~8 s | A hears B's translated interjection before finishing; A's mic stays live |
| 7 | Screen lock (Android) | Lock 5 min while talking | Note whether audio continues |
| 8 | Screen lock (iPhone) | Lock 5 min | Expected to pause; confirm it recovers on unlock |
| 9 | Wi-Fi → mobile data | Toggle Wi-Fi off mid-sentence | "Reconnecting…" then live again within N s (record N) |
| 10 | Headset disconnect | Switch headset off mid-call | Banner + phone mic fallback; reconnect headset → switches back |
| 11 | Incoming phone call | Call one phone | Room recovers after the call |

## M2/M3 — four and eight people

| # | Test | Pass when |
|---|---|---|
| 12 | 3 phones EN/PL/ES | Each hears the other two in their own language with correct names |
| 13 | 1 English speaker, 3 Spanish listeners | One shared en→es session (worker logs show one session) |
| 14 | 2 sustained speakers + 1 interjection | Natural/Focus/Equal modes behave as described; captions show all three |
| 15 | 8 phones, one table, 15 minutes | No drops; record bleed (duplicated translations), echo, delay |
| 16 | Argentine / Colombian / Castilian Spanish speakers | Bilingual reviewer rates accuracy of names, numbers, slang |

## M4 — private groups

| # | Test | Pass when |
|---|---|---|
| 17 | 5 + 3 split ("Living room" / "Outside") | Each group hears only its own people and captions |
| 18 | 4 + 4, 3 + 3 + 2, 2 + 2 + 2 + 2 | Same |
| 19 | Switch mid-monologue | Old group's audio and captions stop immediately; new group live; note switch time |
| 20 | Return to main | One tap; languages and headset unchanged |
| 21 | Owner removes a member | Removed person is back in main, cannot hear the private group |
| 22 | Two groups within earshot | Record acoustic bleed between groups (expected; not a software leak) |

## Results

| Date | Test # | Devices / OS / browser / headset | Network | Result | Measured | Notes |
|---|---|---|---|---|---|---|
| | | | | NOT RUN | | |

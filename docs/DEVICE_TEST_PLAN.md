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
| 6b | Same-room cross-talk | A talks 30 s while B stays silent, ~1 m apart; then side by side | A never hears their own words back; B hears each sentence once; only A's card lights up (simulated: 0 s at 1 m, 0.3–12 s side by side) |
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

## M6 — saved tables, home-screen app, phone away

| # | Test | Pass when |
|---|---|---|
| 23 | Saved table: A starts a table (Remember me on), B joins from its link (Remember me on); both close the browser; later both open Mesa and tap the table | Both are back in one conversation without forms or a new link; names and languages kept |
| 24 | Install on Android: home screen → "Add to home screen" (or browser menu → Install app) | Mesa icon on the home screen; opens full screen, already remembered; WhatsApp table links open in it |
| 25 | Install on iPhone: after joining in Safari, Share → Add to Home Screen | Opens full screen and remembered (iOS copies the sign-in cookie on install); a link pasted on the home screen opens the table |
| 26 | Pocket mode 15 min: mic on, tap the moon, phone in pocket / face down | The other person hears you and you hear them for the whole 15 min; nothing reacts to pocket touches; hold the ring 1.5 s to unlock; note battery % used |
| 27 | Screen off with the power button for 1 min while the mic is on | Expected (browser limit): the other person stops hearing you after a few seconds; Android may keep playing their voice to you; on return a banner offers Pocket mode and the mic works again without reloading |

## Results

| Date | Test # | Devices / OS / browser / headset | Network | Result | Measured | Notes |
|---|---|---|---|---|---|---|
| 2026-11-17 | 1, 3, 4 (informal) | 2 phones + Bluetooth headsets (models not recorded) | home | PASS (owner's report) | — | ES ↔ PL, Spanish output understandable |
| 2026-11-17 | 6b | same | home | **FAIL** | worker log: 51.5 s of leaked Spanish re-voiced and dropped | own words shown as captions under the other person's name; fixed in `270a7ee` (phone-offset alignment + caption retraction), **re-test pending** |
| 2026-11-17 20:28 UTC | 1, 3, 4, 6b (informal, ~17 min) | same | home | translation ran throughout; no problem reported by the owner | phones 510–590 ms out of step; worker dropped 95 s + 63 s of picked-up speech (same-language rule); bleed guard 0 s | captions of dropped stretches are retracted since `270a7ee`; caption names not specifically checked |
| | all others (incl. 23–27) | | | NOT RUN | | |

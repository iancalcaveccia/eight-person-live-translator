# Phones, Bluetooth headsets and browser limits

Status: **none of this has been verified on real phones yet.** Items below are
what the code does and what the platforms document; each needs the device test
in `docs/DEVICE_TEST_PLAN.md`.

## What the web app does

| Concern | Implementation |
|---|---|
| Microphone capture | WebRTC with echo cancellation and noise suppression on, browser auto gain **off** (so a neighbour's quiet leak is not pumped up); mono; Opus speech preset with DTX and RED (redundant packets for loss resilience) |
| Choosing the headset mic | Device list after permission; headset detected by label heuristics (Bluetooth/AirPods/Buds/…); a **local-only loopback recording** confirms which mic is really used |
| Headset disconnects | On `devicechange`, if the active mic vanished the app switches to the default mic and shows a banner; when the preferred headset returns it switches back |
| Output device | Selectable where the browser supports `setSinkId` (Chrome/Android); iOS routes audio itself — the app says so |
| Autoplay | Audio is unlocked on the first tap; if blocked, a "Tap to turn on sound" banner appears |
| Screen lock | Screen Wake Lock keeps the screen on while in a gathering (re-acquired when the page returns to the front) |
| Phone away (pocket mode) | Moon button (top right) or Settings → Start pocket mode: full-screen black overlay that ignores touches, wake lock forced on, text drifts every minute (OLED burn-in), unlock by holding the ring 1.5 s; one "back" gesture only leaves pocket mode. If the page was hidden for more than 6 s with the mic on, a banner says the phone paused the mic and offers pocket mode |
| Remembered on this phone | "Remember me on this phone" (on by default) stores a person (name, languages, consent version) server-side; the phone keeps a 400-day httpOnly cookie (SHA-256 stored). Saved tables: whoever opens a table link once is remembered at it; next time they tap it on the home screen |
| Lock-screen label | Media Session metadata names the table ("Mesa · live interpretation") |
| Network changes | LiveKit ICE restart / reconnection; if the session is lost, the app fetches a fresh token and rejoins the *current* group automatically |
| Noisy table | Standard WebRTC filtering by default; optional Krisp noise removal or **voice focus** (background voice cancellation) on LiveKit Cloud; hold-to-talk as last resort |
| Install | Web app manifest + service worker; an "Add to home screen" card uses Chrome's own install dialog on Android (`beforeinstallprompt`, captured by an inline script before hydration) and shows the Share → Add to Home Screen steps on iPhone (no prompt API there) |

## Known platform limits (do not assume they are solved)

- **No web app keeps the microphone in the background (checked 2026-11-17).**
  Installing Mesa on the home screen does not change this; only a native app
  (iOS background-audio mode, Android foreground service) can. Pocket mode is
  the workaround: the page stays in front with the screen on but black.
- **iPhone (Safari / installed web app):** the microphone is suspended when the
  screen locks or another app comes to the front; audio stops until the page is
  visible again. A phone call interrupts capture; LiveKit reconnects after it,
  but the person is muted during the call. iOS picks the audio route; the page
  cannot force a Bluetooth mic. The installed app has its own storage; iOS 17.2+
  copies Safari's cookies into it at install time, so install *after* joining.
  Links from other apps still open in Safari (paste them on Mesa's home screen).
- **Android Chrome:** the microphone stops about 5 seconds after the screen turns
  off or another app comes to the front, while incoming audio usually keeps
  playing (Chromium issue 374374232; galene issue 342, Oct 2026). Battery savers
  can also disconnect the call. Bluetooth headsets switch to the "hands-free"
  (HFP) profile when the mic is active, which lowers playback quality to
  telephone-like audio on many headsets.
- **Bluetooth latency:** headset playback adds roughly 100–300 ms on top of the
  translation delay; HFP mic audio is narrowband, which can slightly reduce
  recognition accuracy.
- **Same-room bleed:** eight microphones around one table hear each other.
  Server-side group privacy does not change acoustics. Close-to-mouth mics,
  voice focus, and (for declared languages) Gemini's `echoTargetLanguage=false`
  reduce duplicated translations; the worker's bleed guard suppresses an
  obviously-quieter copy of someone else's speech. Residual bleed must be
  measured with real devices.

## When to build a native app

If real-device tests show that a locked iPhone or a pocketed Android phone drops
the conversation in normal use, build thin native clients with the LiveKit iOS
and Android SDKs (background audio mode on iOS, a foreground service on Android).
They would reuse this backend unchanged: same `/api/gatherings/*` endpoints,
same tokens, same worker tracks and captions.

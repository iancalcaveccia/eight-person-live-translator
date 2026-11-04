# Phones, Bluetooth headsets and browser limits

Status: **none of this has been verified on real phones yet.** Items below are
what the code does and what the platforms document; each needs the device test
in `docs/DEVICE_TEST_PLAN.md`.

## What the web app does

| Concern | Implementation |
|---|---|
| Microphone capture | WebRTC with echo cancellation, noise suppression and auto gain on; mono; Opus speech preset with DTX and RED (redundant packets for loss resilience) |
| Choosing the headset mic | Device list after permission; headset detected by label heuristics (Bluetooth/AirPods/Buds/…); a **local-only loopback recording** confirms which mic is really used |
| Headset disconnects | On `devicechange`, if the active mic vanished the app switches to the default mic and shows a banner; when the preferred headset returns it switches back |
| Output device | Selectable where the browser supports `setSinkId` (Chrome/Android); iOS routes audio itself — the app says so |
| Autoplay | Audio is unlocked on the first tap; if blocked, a "Tap to turn on sound" banner appears |
| Screen lock | Screen Wake Lock keeps the screen on while in a gathering (re-acquired when the page returns to the front) |
| Network changes | LiveKit ICE restart / reconnection; if the session is lost, the app fetches a fresh token and rejoins the *current* group automatically |
| Noisy table | Standard WebRTC filtering by default; optional Krisp noise removal or **voice focus** (background voice cancellation) on LiveKit Cloud; hold-to-talk as last resort |
| Install | Web app manifest + service worker: "Add to Home Screen" on iOS, install prompt on Android |

## Known platform limits (do not assume they are solved)

- **iPhone (Safari / installed web app):** the microphone is suspended when the
  screen locks or another app comes to the front; audio stops until the page is
  visible again. The wake lock helps only if the screen is left on. A phone call
  interrupts capture; LiveKit reconnects after it, but the person is muted during
  the call. iOS picks the audio route; the page cannot force a Bluetooth mic.
- **Android Chrome:** capture usually continues with the screen off for a while,
  but battery savers and OEM task killers can stop it. Bluetooth headsets switch
  to the "hands-free" (HFP) profile when the mic is active, which lowers playback
  quality to telephone-like audio on many headsets.
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

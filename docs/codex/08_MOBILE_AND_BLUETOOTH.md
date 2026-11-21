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

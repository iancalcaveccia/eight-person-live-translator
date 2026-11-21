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

# Breakout groups, movement, and private audio — implementation & acceptance spec

## Product definition: one gathering, many independent live conversations

The eight participants **join a single gathering** using a shared invite. They remain members of that gathering until leaving. At any time they can move between **independent conversation groups** of arbitrary size, provided the total gathering membership never exceeds eight. One gathering can be partitioned 5+3, 4+4, 3+3+2, 2+2+2+2, etc. The default main group is one conversation group, NOT a permanent audio feed everybody hears regardless of where they go.

Example: five people continue in `Living room` while three move to `Outside`. The outside three hear ONLY audio (translated or original) from the outside group. The living-room five hear ONLY their own group's audio. Members remain connected to gathering-level presence and can return to the main group or join an invited group without creating accounts, exchanging new URLs, or rescanning the gathering QR code.

This is a **high-priority release gate** alongside streaming, interruptions and privacy. Users must not have to end the gathering to form a breakout group.

## User-facing behavior

- Main gathering link admits up to 8 people, with existing speaking language, listening language, Spanish locale, headset configuration and distinct speaker voice identity saved per participant.
- Screen shows **Your conversation: Living room (5 people)** and the current group members by name. A compact **Switch conversation** control opens the group menu.
- Any participant may create a group: name it (e.g. `Outside`, `Kitchen`, `Private chat`), choose invitation-only membership (default), and invite selected participants. For user comfort, invitations show the inviter, group name and target members; no automatic transfer without acceptance.
- Invitee can accept, decline, or remain in current group; accepting makes them leave their old group's live audio and enter the new group's audio. Provide visible confirmation **You are speaking only with: [names]**.
- Any participant can return to the shared **Main conversation** with one tap. The main group is accessible to any admitted gathering participant unless the gathering has ended. Additional groups are private/invitation-only by default.
- Group members can send invitations and the group creator can remove participants. Changes must be authoritative and affect translation streams and captions, not just a local mute state.
- No need to end/recreate gathering on switching. Preserve headset and language settings. Provide short **Switching... / Connected** feedback during media rejoin. Seek a fast transition, but do not promise seamless or interruption-free media across group changes when provider sessions/WebRTC rejoin are needed.
- Audio delivery within each group must continue to be **continuous**, low-lag, full duplex, and allow brief translated interruptions in a different speaker's voice. Global mixing across groups is NEVER allowed.
- A participant is in **exactly one active audio conversation** at a time for MVP; optionally they can be in a silent waiting/lobby state. Do not implement background eavesdropping on several groups simultaneously.
- When leaving, immediately stop outgoing microphone publication to the old group and unsubscribe/stop playback of its incoming tracks; clear private captions and any queued translated audio from its UI. Do not let a few stale seconds of old-group speech play after switching.
- UI may show group sizes and invitations, but avoid revealing private membership, titles, transcripts or speaker activity to people not authorized for that group. Use neutral labels for private groups visible to nonmembers, or hide them entirely.

## Architecture and privacy boundary (mandatory)

Keep **gathering membership/presence** separate from **audio conversation group membership**. The preferred robust MVP architecture is **a control-plane gathering with one distinct LiveKit media room per active conversation group**. Do not place everybody on one LiveKit room with only client-side mutes/filters and claim groups are private.

- Backend stores `gatheringId`, `participantId`, `groupId`, active `membership`, invitations, roles and session epoch/version. Control plane manages authenticated gathering presence and group transitions.
- Issue short-lived LiveKit media room tokens scoped to the participant's *current authorized group only*. Enforce group membership and publish/subscribe permissions server-side. Do not expose other groups' credentials to unauthorized clients.
- On switch: authorize target group -> revoke/expire or disconnect prior media-room participant and cancel old translation subscriptions/jobs -> stop mic publication and playout locally -> join target group's media room -> publish mic and subscribe to authorized original/translation tracks. Ensure old room receives no new mic frames once the switch is confirmed. Handle rollback safely if target join fails (never publish into both groups concurrently).
- A single person must not hold two active group media memberships. Use serializable state transition/epoch to avoid stale tabs, delayed token response, rapid back/forth movement, mobile reconnect races and replay of expired credentials.
- Translation stream keys **must include group identity**: `(gatheringId, groupId, speakerParticipantId, targetLanguage)`. Workers subscribe only to tracks of authorized members in their media room, and publish translated tracks and subtitles only to that same group. No cross-group forwarding, even if the same language target exists in several groups. Release resources for empty groups and stop generating outputs when nobody in that group requires a target language.
- Captions, speaker labels, optional ephemeral transcripts, mixer inputs, voice-profile settings and captions history remain scoped to currently authorized group. Clearing local state is additional to, not a replacement for, server-side group isolation.
- Avoid audio recordings and persisted transcripts by default. Keep diagnostics aggregated/redacted. All participant voice processing still happens via chosen AI service and infrastructure: **private from other groups does not mean end-to-end private from the AI provider**. Clearly disclose this to participants.
- People are physically near one another. A headset mic can unintentionally capture voices from a nearby group, which is an **acoustic limitation** even with server-side group isolation. Require headset checks, mic positioning, noise suppression and an optional manual mic mute / push-to-talk fallback. Do not promise the app can eliminate ambient speech leaking through someone's microphone.
- On an unauthorized attempt to subscribe/join or fetch captions from another group's media room, reject **on the server**, not merely by hiding UI. Avoid leaking group metadata through room APIs, invitations or socket broadcasts. Consider abuse (stolen invite, stale session, deep link reentry, privilege escalation) and test it.

## UX transition and quality goals

- Target one or two user taps to move to a group, once invited; no new link, login, app restart, language reconfirmation or headset re-pairing.
- Make media switch measured: time from accept/return action to first audible authorized live audio. Aim for a quick switch under good conditions; do not assert hard sub-second continuity without physical testing.
- Source speaker identity, unique translated voice and regional language preferences must persist across groups; never swap people or voices when groups split/merge.
- Existing live streaming/interruption performance requirements apply **independently per group**.
- Group-local translation work should use no more active source-target sessions than demand warrants. Do not keep all 8 people's translation workers broadcasting in a global main group when that group has shrunk to 5.

## Required manual and automated tests

1. Connect 8 phones with headsets. Divide 5 `Living room` + 3 `Outside`. Speak simultaneously in Polish, Spanish and English in both groups. Verify each listener receives ONLY translations/original streams from their active group, including subtitles and identifying voice.
2. Split to 4+4, 3+3+2 and 2+2+2+2. Ensure all voice identities persist and nobody must reconnect to the gathering.
3. Have one invited person switch from `Outside` to `Living room` mid-monologue. Prove old audio and captions stop, new ones start, and the microphone is never published to both groups. Test a brief translated interruption after rejoining.
4. Attempt unauthorized entry and subscriptions to another private LiveKit room by guessing a group ID, replaying old tokens, calling subscription APIs, or rapidly switching from two phone tabs. All must be denied server-side; no voice/captions leak.
5. Test declined invite, room owner removes guest, last member leaves, main group becomes temporarily empty, one member loses network mid-switch, host ends gathering, and headset drops during switch.
6. Confirm group rename/create/destroy and visibility rules; do not display private members or conversation activity to outsiders.
7. Test two groups sitting within microphone range to reveal acoustic bleed; document how much physical noise suppression helps and when only moving away or push-to-talk provides useful privacy.
8. Measure switching latency, translation streaming latency, interrupted-speaker delay and API cost per active group. Never report test results that were not performed with actual phones and headsets.

## Explicit non-goals for MVP

- Cross-group broadcast/eavesdropping; one person listening to several groups simultaneously.
- Perfect secrecy from someone who can physically overhear a group or whose headset microphone captures nearby people.
- Guaranteed uninterrupted translated audio during a WebRTC/provider switch or guaranteed zero latency.
- Recording, searchable private transcript archives, hidden invitations or automatic geolocation-based group assignment.

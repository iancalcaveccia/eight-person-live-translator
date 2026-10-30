# Interface contract: control plane ⇄ translator worker ⇄ browser

This file is the single source of truth for every name, attribute, topic and
HTTP shape shared between the three moving parts. If you change anything
here, change both implementations and their tests in the same commit.

- **Control plane** — Next.js on Vercel (`src/`). Owns gatherings, groups,
  invitations, consent, budget, token minting. Postgres is authoritative.
- **Translator worker** — Python LiveKit Agent on LiveKit Cloud
  (`translator/`). One job per *group media room*.
- **Browser client** — React UI (`src/app/...`). Connects to exactly one group
  media room at a time.

## 1. Identities and rooms

| Concept | Format | Notes |
|---|---|---|
| `gatheringId` | UUID v4 | Permanent container for ≤ 8 humans |
| `groupId` | UUID v4 | One per conversation group. Every gathering has exactly one `main` group |
| `participantId` | UUID v4 | Stable per human per gathering. **Used verbatim as the LiveKit identity** |
| LiveKit room name | `grp_` + 24 random base32 chars | One room per group. Random, never derived from user input. Stored in `groups.livekit_room` |
| Agent name | `gemini-translator` | Dispatch name (kept from upstream) |

A human holds a media token for **one** group room at a time. Group rooms are
created lazily on first token mint with the agent dispatch embedded in the
token's `RoomConfiguration`.

`RoomConfiguration` on every token:

```
agents: [{ agentName: "gemini-translator", metadata: <dispatch JSON> }]
emptyTimeout: 60           # seconds
departureTimeout: 20       # seconds after the last human leaves
maxParticipants: 10        # 8 humans + 1 agent + 1 reconnect slack (humans capped at 8 by the DB)
```

Dispatch metadata JSON (server-signed because it lives inside the JWT):

```json
{"v":1,"gatheringId":"<uuid>","groupId":"<uuid>","room":"grp_..."}
```

## 2. Participant attributes (server-authoritative)

Tokens are minted with `canUpdateOwnMetadata: false`. Clients **cannot** change
their attributes; the control plane sets them in the token and updates them
via `RoomServiceClient.updateParticipant()` when preferences change. The worker
may therefore trust them, except `epoch` which it must verify through
admission (section 6) because an old token carries an old epoch.

| Key | Values | Meaning |
|---|---|---|
| `interp.v` | `"1"` | Contract version |
| `speak_lang` | `en` \| `pl` \| `es` \| `auto` | Language this person speaks. `auto` = provider auto-detects; enables language switching |
| `listen_lang` | `en` \| `pl` \| `es` | Language this person wants to hear |
| `es_region` | `""` \| `es-AR` \| `es-CO` \| `es-ES` | UI / evaluation metadata only. **Never** sent to a provider (no provider supports regional targets) |
| `role` | `host` \| `guest` | |
| `color` | `"0"`..`"7"` | Stable speaker colour slot for UI |
| `gathering_id` | UUID | |
| `group_id` | UUID | |
| `epoch` | decimal string | Participant's active-group epoch at token mint |

Display name is the LiveKit participant `name`.

The worker ignores remote participants whose `kind` is AGENT and anyone who
lacks `speak_lang`/`listen_lang`.

## 3. Demand and routing rules

Within one group room let `H` be the admitted humans.

**Sessions (worker).** For each speaker `S ∈ H` with a subscribed, unmuted
microphone track, the set of target languages is

```
targets(S) = { L.listen_lang : L ∈ H, L ≠ S }  −  ({ S.speak_lang } if S.speak_lang ≠ "auto" else ∅)
```

One translation session exists per `(gatheringId, groupId, S, target)`.
A session is **shared by every listener** in the group who wants that target.
A listener never causes a second paid session for the same `(S, target)`.

- `echoTargetLanguage` (Gemini) is `false` for declared speakers (protects
  against microphone bleed of same-language neighbours being re-voiced) and
  `true` for `auto` speakers (so speech already in the target language is
  still delivered).
- Speaking your own listening language costs nothing: no `(S, S.listen_lang)`
  session unless another listener needs it.

**Subscriptions (browser).** Listener `X` subscribes, for each other human `S`:

- native mic of `S` **iff** `S.speak_lang ≠ "auto"` and `S.speak_lang = X.listen_lang`
  (and X has not disabled "same-language voices in headset"), **or** X has
  explicitly chosen "hear original" for `S`;
- otherwise the worker track `tx:S:X.listen_lang`.

Never both for the same speaker at the same time, except the explicit
"original underneath" balance option (original at reduced gain).

## 4. Tracks published by the worker

| Track name | Content |
|---|---|
| `tx:<speakerId>:<targetLang>` | Primary translated audio, 24 kHz mono, published by the agent participant |
| `txc:<speakerId>:<targetLang>:<provider>` | Optional comparison track (only when `PROVIDER_COMPARE=true`) |

Speaker ids are UUIDs (no `:`), so parsing is `split(":")`.

## 5. Text streams and data packets

### 5.1 Captions — text stream topic `lk.translation`

Published by the agent with `sender_identity = <speakerId>`. One stream per
provider transcript chunk (append semantics). Attributes:

| Attribute | Values |
|---|---|
| `kind` | `translation` (target-language text) \| `source` (source-language text) |
| `source_identity` | speaker id |
| `target_lang` | target language (for `kind=translation`) |
| `source_lang` | detected source language code if the provider reports one, else `""` |
| `final` | `"true"` closes the current utterance segment, `"false"` otherwise |
| `seg` | decimal segment counter per `(speaker, target, kind)` |
| `provider` | `gemini` \| `openai` \| `mock` |

Only **one** session per speaker publishes `kind=source` (the session whose
target sorts first), to avoid duplicates. Captions are never persisted by
either side.

### 5.2 Worker events — data packets, topic `interp.events`, reliable, JSON

```jsonc
{"t":"onset","speaker":"<id>","ts":1730000000000}            // speech onset detected at worker input (worker clock, ms)
{"t":"first_audio","speaker":"<id>","target":"pl","provider":"gemini","latencyMs":1830}
                                                              // first translated audio published after that onset
{"t":"session","speaker":"<id>","target":"pl","provider":"gemini",
 "state":"connecting|live|delayed|reconnecting|error|stopped","backlogMs":0,"reason":null}
{"t":"budget","state":"ok|warning|exceeded","reason":null}
{"t":"stats","sessions":[{"speaker":"<id>","target":"pl","provider":"gemini",
  "firstAudioP50Ms":1800,"firstAudioP95Ms":2600,"backlogMs":120,"stalls":0,"droppedMs":0}]}
```

`state` meanings: `live` = audio flowing within normal lag; `delayed` = output
backlog above the soft limit or no output for > 6 s while input speech is
active; `reconnecting` = provider socket being re-established.

The agent also keeps a summary in its participant attribute `interp.status`
(JSON string `{"budget":"ok","sessions":N,"provider":"gemini"}`).

### 5.3 Control-plane nudges — data packets, topic `interp.control`

Sent by the control plane through `RoomServiceClient.sendData` to specific
identities:

```json
{"t":"refresh"}                      // re-fetch /state now (invitation, membership change)
{"t":"moved","groupId":"<uuid>"}     // you were moved; fetch a new token
{"t":"ended"}                        // gathering ended
```

Clients must treat these as hints only and always re-read `/state`.

## 6. Internal HTTP API (worker → control plane)

Base URL: `CONTROL_PLANE_URL` (e.g. `https://<app>.vercel.app`).

**Signing.** Every request carries

```
X-Interp-Timestamp: <unix seconds>
X-Interp-Signature: v1=<hex(HMAC_SHA256(INTERNAL_API_SECRET, "<timestamp>.<raw body>"))>
Content-Type: application/json
```

The server rejects missing/invalid signatures and timestamps more than 120 s
from its clock, compares in constant time, and never logs bodies.

Test vector (both implementations must have a unit test for it):

```
secret    = "test-secret"
timestamp = "1700000000"
body      = {"room":"grp_test","identities":["p1"]}
signature = v1=81db07323246d44a782b096c988c871b5c323017ba636958c89b1bd643c5214d
```

### 6.1 `POST /api/internal/admission`

Request:

```json
{"room":"grp_...","identities":["<participantId>", "..."]}
```

Response 200:

```json
{
  "gatheringId":"<uuid>", "groupId":"<uuid>",
  "participants":{
    "<participantId>":{"allowed":true,"epoch":4,"reason":null},
    "<other>":{"allowed":false,"epoch":null,"reason":"not_in_group"}
  },
  "translation":{"allowed":true,"reason":null,"defaultProvider":"gemini"}
}
```

Unknown room → 404. `allowed:false` reasons: `unknown`, `not_in_group`,
`stale_epoch`, `kicked`, `left`, `gathering_ended`.

The worker calls admission when a participant connects (batched with a
≤ 300 ms debounce), and re-verifies all present humans every 20 s. On
`allowed:false` it removes the participant from the room via the LiveKit API
(`RoomService.RemoveParticipant`) and never translates them. The epoch check
compares the participant's `epoch` attribute with the server's
`active_epoch`; a mismatch is `stale_epoch`.

Failure policy: positive results are cached 60 s. If the control plane is
unreachable the worker retries with backoff; humans never admitted within
`ADMISSION_FAIL_CLOSED_SEC` (default 30) are removed. If `CONTROL_PLANE_URL`
is unset the worker runs in **standalone dev mode** (admits everyone, logs a
warning on every job) — production deployments must set it.

### 6.2 `POST /api/internal/usage`

Sent every 15 s while any session is open, and once at job shutdown.

```json
{
  "room":"grp_...","gatheringId":"<uuid>","groupId":"<uuid>",
  "records":[{
    "speakerId":"<uuid>","targetLang":"pl","provider":"gemini",
    "inputSeconds":12.4,"outputSeconds":9.1,"sessionSeconds":15.0,
    "periodStart":"2026-10-30T10:00:00Z","periodEnd":"2026-10-30T10:00:15Z",
    "errors":0,"firstAudioMs":[1830,2010]
  }]
}
```

`inputSeconds` = seconds of audio actually sent to the provider (after the
silence gate). `outputSeconds` = seconds of translated audio received.
`firstAudioMs` = onset→first-audio samples observed in this period (no content).

Response 200:

```json
{"translation":{"allowed":true,"reason":null},
 "spend":{"gatheringUsd":1.23,"monthUsd":10.5,"capGatheringUsd":50,"capMonthUsd":200}}
```

When `translation.allowed` is `false` (`reason`: `gathering_cap`,
`monthly_cap`, `daily_cap`, `gathering_ended`), the worker closes every
session within 2 s, publishes `{"t":"budget","state":"exceeded"}` and starts
no new sessions until a later response allows it.

## 7. Cost model (server side, configurable)

Estimated USD per record:

```
gemini: inputSeconds/60 * GEMINI_INPUT_USD_PER_MIN (0.0053) + outputSeconds/60 * GEMINI_OUTPUT_USD_PER_MIN (0.0315)
openai: sessionSeconds/60 * OPENAI_TRANSLATE_USD_PER_MIN (0.034)
mock:   0
```

Rates are the published list prices on 2026-10-30 and must be re-checked
against provider billing. The estimate is a meter, not an invoice.

## 8. Environment variables

Worker (`translator/.env.local`, LiveKit Cloud secrets):

| Name | Required | Default |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | yes | |
| `GEMINI_API_KEY` | for gemini | |
| `GEMINI_MODEL` | no | `gemini-3.5-live-translate-preview` |
| `OPENAI_API_KEY` | for openai | |
| `OPENAI_TRANSLATE_MODEL` | no | `gpt-realtime-translate` |
| `TRANSLATION_PROVIDER` | no | `gemini` (`gemini`\|`openai`\|`mock`) |
| `PROVIDER_FALLBACK` | no | `true` |
| `PROVIDER_COMPARE` | no | `false` |
| `CONTROL_PLANE_URL` | production | |
| `INTERNAL_API_SECRET` | production | |
| `INPUT_GATE` | no | `true` |
| `BLEED_GUARD` | no | `true` |

Control plane (`.env.local`, Vercel env): `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET`, `HOST_ACCESS_CODE`,
`NEXT_PUBLIC_APP_URL`, `GATHERING_MAX_HUMANS` (8), `MAX_GATHERING_SESSION_MINUTES`,
`MAX_AI_SPEND_PER_GATHERING_USD` (50), `MAX_AI_SPEND_DAILY_USD` (optional),
`MAX_AI_SPEND_MONTHLY_USD` (200), `CRON_SECRET`. None of these use the
`NEXT_PUBLIC_` prefix except `NEXT_PUBLIC_APP_URL`.

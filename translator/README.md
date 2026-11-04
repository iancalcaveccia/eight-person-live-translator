<a href="https://livekit.io/">
  <img src="./.github/assets/livekit-mark.png" alt="LiveKit logo" width="100" height="100">
</a>

# Translator worker (Python, LiveKit Agents)

Streaming speech-to-speech interpretation for one **group media room** of an
eight-person gathering. Derived from the MIT-licensed
[livekit-examples/gemini-live-translate](https://github.com/livekit-examples/gemini-live-translate).

- One job per group room (dispatched by the control plane's media tokens,
  agent name `gemini-translator`).
- One translation session per `(gathering, group, speaker, target language)`,
  shared by every listener in that group who wants that language. Eight
  people speaking three languages = at most 16 sessions.
- Each speaker's mic is read once and streamed continuously (100 ms chunks to
  Gemini); translated audio is published to `tx:<speaker>:<lang>` the moment
  it arrives. Nothing waits for the end of an utterance.
- Overlapping speakers are independent sessions and tracks, so interjections
  are never queued behind a monologue.
- Participants are admitted by the control plane (HMAC-signed internal API);
  unauthorised or stale-epoch participants are removed from the room.
- Usage is metered (input/output seconds per session, no audio or text) and
  translation stops when the control plane reports a spending cap.

Design, tunables and limitations: [`docs/architecture/WORKER.md`](../docs/architecture/WORKER.md).
Shared names and HTTP shapes: [`docs/architecture/CONTRACT.md`](../docs/architecture/CONTRACT.md).

## Providers

| Provider | Model | Targets used here | Notes |
|---|---|---|---|
| `gemini` (primary) | `gemini-3.5-live-translate-preview` | en, pl, es | 16 kHz in / 24 kHz out, raw v1beta WebSocket, key in `x-goog-api-key` header |
| `openai` (optional) | `gpt-realtime-translate` | en, es | `/v1/realtime/translations`; **cannot output Polish**, so Polish targets always use Gemini |
| `mock` | — | en, pl, es | Deterministic delayed passthrough for tests and local runs; free, offline |

Regional Spanish (`es-AR`, `es-CO`, `es-ES`) is UI/evaluation metadata only; no
provider accepts a regional target, so `es` is sent.

## Run locally

```bash
uv sync
cp .env.example .env.local      # fill in LiveKit + provider keys
uv run python src/agent.py dev
```

With no provider key, set `TRANSLATION_PROVIDER=mock` to exercise the whole
pipeline for free. Without `CONTROL_PLANE_URL` the worker runs in
**standalone dev mode** and admits everyone (it logs a warning) — never deploy
like that.

## Test and lint

```bash
uv run pytest                    # unit + protocol tests (fake Gemini/OpenAI servers)
uv run ruff check && uv run ruff format --check
```

End-to-end over real WebRTC with a local LiveKit server and the mock provider
(starts `livekit-server --dev` if nothing listens on :7880; set
`LIVEKIT_SERVER_BIN` to the binary path):

```bash
LIVEKIT_INTEGRATION=1 uv run pytest tests/integration -s
```

## Measure real latency

`scripts/latency_probe.py` publishes WAV clips as a speaker, listens to the
translated track and reports onset → first translated audio (p50/p95),
whether translation began before the clip ended, end catch-up and optional
interjection latency. Run it against a worker started in standalone mode with
a separate agent name so it cannot collide with production:

```bash
TRANSLATOR_AGENT_NAME=interp-probe CONTROL_PLANE_URL= uv run python src/agent.py start
uv run python scripts/latency_probe.py --agent-name interp-probe \
  --speaker-wav clips/es_ar_30s.wav --speaker-lang es --listener-lang pl \
  --interjection-wav clips/pl_co_serio.wav --interjection-at 8 --repeat 5 \
  --out results/es-pl.json
```

## Deploy to LiveKit Cloud

```bash
lk cloud auth                                  # once, opens the browser
lk agent create --region <region> --secrets-file .env.local .   # first time
lk agent deploy                                # later deploys
lk agent logs                                  # runtime logs
```

`.env.local` for production must set `CONTROL_PLANE_URL` and
`INTERNAL_API_SECRET` (same value as the web app). The Dockerfile is the one
LiveKit Cloud builds.

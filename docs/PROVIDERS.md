# Translation providers: Gemini Live Translate vs OpenAI Realtime Translate

Checked against the official documentation on **2026-10-30**. Both models are
dedicated streaming speech-to-speech *translation* endpoints (not chat or
voice-agent endpoints). Preview APIs change; re-check before relying on any
line here.

| | Gemini 3.5 Live Translate (primary) | OpenAI `gpt-realtime-translate` (backup) |
|---|---|---|
| Model id | `gemini-3.5-live-translate-preview` | `gpt-realtime-translate` |
| Transport used by the worker | WebSocket `v1beta …BidiGenerateContent` | WebSocket `wss://api.openai.com/v1/realtime/translations?model=…` |
| Configuration | `generationConfig.translationConfig = { targetLanguageCode, echoTargetLanguage }` | `session.update` → `session.audio.output.language`, input transcription `gpt-realtime-whisper`, `noise_reduction: near_field` |
| Input audio | PCM16 16 kHz mono, ~100 ms chunks | PCM16 24 kHz mono, sent continuously (incl. silence) |
| Output audio | PCM16 24 kHz, streamed `inlineData` | PCM16 24 kHz, `session.output_audio.delta`, ~200 ms chunks |
| Captions | input + output transcription, with `languageCode` | `session.input_transcript.delta`, `session.output_transcript.delta` |
| Target **Polish** | **yes** | **no** — Polish is input-only (13 output languages) |
| Target Spanish / English | yes / yes | yes / yes |
| Regional Spanish (es-AR/CO/ES) | no regional codes; only `es` | not documented; treated as `es` |
| Voice | adaptive voice preservation; Google warns it can shift after pauses, pick the wrong gender, or stick during fast multi-speaker talk | dynamic voice adaptation; **no voice selection** |
| Price (list) | $0.0053/min input + $0.0315/min output (25 tokens/s) | $0.034 per minute of audio |
| System prompts / glossaries | not supported | not supported |

## Consequences for this product

- **Gemini must stay primary for any Polish listener.** The worker's capability
  table (`translator/src/providers/base.py`) refuses OpenAI for `pl` targets, and
  fallback to OpenAI only happens for `en`/`es` targets.
- **Spanish regions are metadata.** Participants choose Argentina / Colombia /
  España; it is shown to others and recorded for evaluation, but no provider can
  currently synthesise a specific regional accent. The UI says so.
- **No voice picker.** Neither dedicated model accepts a voice parameter, so the
  app does not show one. Each speaker gets a stable name, colour and their own
  translated track; the voice timbre is the model's best effort.
- **Voice cloning is not implemented.** Google's separate voice-replication API
  (Gemini TTS) is a text-to-speech pipeline that would add latency and requires
  verified, revocable adult consent per speaker. It is out of the real-time path
  and remains a documented future experiment (M6).

## A/B comparison status

**Not yet run** — it needs real API keys and native speakers. The tooling is in
place:

- `PROVIDER_COMPARE=true` on the worker publishes an extra
  `txc:<speaker>:<target>:openai` track next to the primary Gemini track (only for
  targets OpenAI supports: `en`, `es`). Listeners can switch to it per speaker
  (`compareFor` routing), so bilingual reviewers can compare live.
- `translator/scripts/latency_probe.py` replays WAV files through a real LiveKit
  room and measures onset → first translated audio, whether translation began
  before the source ended, and rolling lag, for either provider.

Planned matrix (per `docs/codex/09_TEST_MATRIX.md`): pl→es, es→pl, en→pl, pl→en,
es→en, en→es; Argentine, Colombian and Castilian speakers; fast speech; names and
numbers; interruptions; voice consistency; first-audio p50/p95; cost per hour.
OpenAI can only be compared on the `→es` and `→en` directions.

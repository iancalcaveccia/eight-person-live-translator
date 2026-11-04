# Primary technical sources — reviewed 2026-10-27

1. LiveKit eight-person MIT starter, Next.js + Python Agent and deployment quickstart: https://github.com/livekit-examples/gemini-live-translate
2. Google Gemini 3.5 Live Translate: https://ai.google.dev/gemini-api/docs/live-api/live-translate
3. Gemini Live Translate model card: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview
4. Official Gemini pricing (verify before billing): https://ai.google.dev/gemini-api/docs/pricing
5. OpenAI realtime translation architecture and streaming protocols: https://developers.openai.com/api/docs/guides/realtime-translation
6. OpenAI translation model: https://developers.openai.com/api/docs/models/gpt-realtime-translate
7. OpenAI realtime translation cookbook, dynamic voice adaptation & lack of voice selection: https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide
8. Google voice replication, independent TTS, adult-speaker consent: https://ai.google.dev/gemini-api/docs/voice-replication
9. LiveKit Agent deployment (containers and cloud): https://docs.livekit.io/deploy/agents/
10. LiveKit Cloud console: https://cloud.livekit.io
11. Google AI Studio and keys: https://aistudio.google.com
12. Vercel deploy: https://vercel.com
13. OpenAI developer API: https://platform.openai.com

## Confirmed distinctions

- The Google dedicated model streams translation while a person is talking. Input 16kHz PCM16, output 24kHz PCM16; documentation recommends ~100ms chunks.
- The OpenAI dedicated translation model is NOT a chat/assistant; WebRTC or WebSockets to `/v1/realtime/translations`, no `response.create`. WebSocket requires 24kHz PCM16 in ~200ms chunks and emits continuous translated audio; official cookbook says no custom voice selection.
- The upstream LiveKit example actually has 8-participant rooms, demand-driven per-(speaker,target-language) sessions, separate tracks and a Python agent. It is a starting point, NOT a validated app with your breakout security or 8-device hardware test.
- Google voice replication via Gemini 3.8 TTS is SEPARATE from Gemini 3.5 Live Translate and requires clean reference + explicit consent by adult voice owner. Do not claim exact voice replication is built into streaming interpreter.
- A Vercel site cannot keep a Python translation worker alive for 8 concurrent microphone streams with typical stateless functions. LiveKit Cloud Agents is the recommended long-running worker.
- Preview API names, limits, quotas, dialect support and prices may change. Codex must check docs in its actual execution environment, and preserve compatibility in pinned versions.

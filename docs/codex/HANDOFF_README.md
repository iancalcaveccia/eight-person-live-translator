# Eight-Person Live Interpreter — Complete Codex Handoff

**October 27, 2026** · Detailed engineering brief and deployment handoff for building a real-time AI interpreter for eight phones.

**This package does not contain a finished web application and is not a claim of deployment.** It supplies the instructions, acceptance tests and environment samples for Codex to adapt the working MIT-licensed LiveKit/Gemini example:
https://github.com/livekit-examples/gemini-live-translate

## Fastest route

1. Read `00_START_HERE.md`.
2. Fork the upstream project to your GitHub account.
3. Put this pack's Markdown specs under `docs/codex/` and root `AGENTS.md` at repository root.
4. Open Codex at https://chatgpt.com/codex, select your fork, and paste `01_MASTER_CODEX_PROMPT.md`.
5. Ask Codex to **build and test M0 + M1 now**. It should implement working code, not produce only a plan.
6. Configure LiveKit Cloud + Gemini API + Vercel secrets using `10_DEPLOYMENT_AND_ENV.md` as the guide; add a DB for breakouts.
7. Test with real phones before considering it functional for eight people.

## Included

Master Codex task; product UX; architecture; continuous low-latency streaming; natural overlaps; private breakout privacy; voices and opt-in cloning; mobile & Bluetooth testing; complete acceptance test matrix; Vercel/LiveKit deployment; environment placeholders; security/cost observability; roadmap; repo handoff; official references.

Priorities: Real translation begins *while someone speaks*, short interruptions are audible, different speakers are separately identifiable, server-isolated breakouts are private, and cost is controlled. There are no promised perfect translations, zero latency, exact voice clones or universal screen-lock support.

# GitHub and Codex operating instructions

## Easiest route: Codex cloud on your GitHub repository

1. Open https://github.com/livekit-examples/gemini-live-translate and use **Fork** to create a repository in your OWN GitHub account. Leave the upstream repository untouched. If fork isn't available, import source under correct MIT attribution and disclose it.
2. Extract this ZIP. Commit ALL `.md` specification files and the `ENV_EXAMPLE_*` placeholders in a `docs/codex/` folder in your fork, but keep root `AGENTS.md` so Codex sees the operating rules. Do NOT push `.env.local`, API keys or phone recordings.
3. Open https://chatgpt.com/codex, select your GitHub fork. The GitHub connection in normal ChatGPT does not automatically guarantee Codex has access; approve it if prompted.
4. Open a new coding task and paste the FULL contents of `01_MASTER_CODEX_PROMPT.md`. Ask Codex to perform M0+M1 immediately, push branch/PR, run automated checks, and report actual behavior and blockers.
5. Review PR and decide whether to merge, then ask Codex to continue with M2/M3/M4; don't call the job complete because screenshots or UI look good.
6. Create LiveKit Cloud and Google AI Studio keys. Add them only to secure environment/Secrets areas; never paste sensitive values into the Codex task.
7. Once working, connect fork to Vercel and deploy worker on LiveKit Cloud. Test real end-to-end audio on phones.

## CLI route (if using local Codex instead)

```bash
# Clone YOUR fork URL, not the original repository, then copy in docs.
git clone https://github.com/YOUR-USER/eight-person-live-translator.git
cd eight-person-live-translator
# Put this pack's specs in docs/codex, and AGENTS.md at repo root.
# Open this folder with Codex CLI/IDE and give it 01_MASTER_CODEX_PROMPT.md.
```

Commands for install/test are documented by the upstream repository. Codex should preserve dependency pinning and provide reproducible steps for your machine.

## Suggested first message to Codex

> Read all docs in `docs/codex/` and root `AGENTS.md`. Execute the full `01_MASTER_CODEX_PROMPT.md`, starting immediately with M0 and M1. Don't respond with only a plan. First reproduce upstream, then implement and validate 2-person Polish/Spanish continuous streaming translation, with a secure path to deploy Vercel + LiveKit. Create commits/PR with tests and a candid status report. Proceed to later milestones if possible.

## If Codex can't deploy

It can still implement the actual application code and tests. Missing Vercel/LiveKit authorizations or Google billing credentials are **blocking prerequisites** for a public working deployment. Report blockers exactly; never invent a live domain.

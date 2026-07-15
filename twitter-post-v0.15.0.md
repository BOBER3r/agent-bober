# agent-bober v0.15.0 — Twitter / X announcement

> Draft copy for launching v0.15.0. Pick the single tweet or the thread. Swap in your real
> handle/links. (This file is for you — it is NOT shipped in the npm package.)

---

## Option A — single tweet

> 🦫 agent-bober v0.15.0 is live on npm.
>
> A multi-agent harness that ships features autonomously: Researcher → Planner → Curator → Generator → Evaluator, with brutally honest quality gates at every step.
>
> Now with **Claude Opus 4.8** + automatic prompt caching.
>
> npm i -g agent-bober
>
> npmjs.com/package/agent-bober

---

## Option B — thread

**1/**
> 🦫 Shipped: agent-bober v0.15.0.
>
> It's a multi-agent harness that builds software autonomously — you describe a feature, it researches your code, plans sprints, writes them, and an independent Evaluator verifies each one (typecheck/lint/build/tests) before moving on.
>
> npm i -g agent-bober

**2/**
> The loop, end to end:
>
> Researcher (facts-only, two-phase) → Planner (sprint contracts) → Curator (pulls real patterns + utils per sprint) → Generator (writes it) → Evaluator (verifies it, sends it back if it fails).
>
> Quality gates, not vibes.

**3/**
> New in 0.15.0:
> • Claude **Opus 4.8** support (1M context, adaptive thinking)
> • Automatic Anthropic **prompt caching** — big input-token savings on multi-turn runs
> • `effort` control (low → max)
> • SDK bumped to the latest

**4/**
> Works with **Claude, GPT, Gemini, Ollama** — mix providers per agent role (plan with Opus, generate with a local model, whatever).
>
> Drops into **Claude Code, Cursor & Windsurf** as an MCP server with **37 tools**. Or just use the CLI.

**5/**
> Plus modes for real work, not just demos:
> • Careful-flow — checkpoint approvals before risky changes
> • Diagnose / Postmortem — for when prod is on fire
> • Brownfield auto-discovery — points it at an existing repo, it figures out your conventions

**6/**
> Optional: install the `tokensave` graph engine and agent-bober gains semantic code search, impact analysis, and auto-generated onboarding docs.
>
> MIT licensed. Try it, break it, tell me what's missing 👇
>
> github.com/BOBER3r/agent-bober

---

## Try-it block (paste into a reply / DM to friends)

```bash
# 1) install
npm i -g agent-bober

# 2) set your key (any one provider works to start)
export ANTHROPIC_API_KEY=sk-ant-...

# 3) point it at a project and go
cd your-project
agent-bober init
agent-bober run "add a /healthz endpoint with a test"
```

**Optional — graph features** (semantic search / impact / onboarding) need the `tokensave` binary
(it's a native Rust binary, not bundled with npm):

```bash
brew install aovestdipaperino/tap/tokensave   # or: cargo install tokensave
```

The core pipeline works fine without it.

---

## Notes for you before posting
- Confirm v0.15.0 is actually published (`npm view agent-bober version`) before the tweet goes out.
- The npm version badge in the README will update automatically once published.
- If `agentbober.com` has a landing page, lead with that link instead of the npm URL.

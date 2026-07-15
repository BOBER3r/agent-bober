# Research: Telegram bot-to-bot + secretary-bot features (2026) — validated findings + topology recommendation

**Research ID:** research-20260628-telegram-features-and-topology
**Generated:** 2026-06-28
**Method:** `/deep-research` harness — 98 agents, ~3.07M tokens, 25 falsifiable claims → 13 confirmed / 12 killed by 3-vote adversarial verification. The harness's final *synthesis* step failed on a session limit, so this synthesis is authored from the verified claim set.
**Companion (codebase):** `research-20260628-telegram-multi-llm-coordination-research.md`
**Feeds:** enriching spec #8 `spec-20260628-telegram-frontend`

---

## 0. Headline (correction to an earlier assumption)

Telegram **Bot API 10.0 (May 8, 2026)** introduced **real bot-to-bot communication** and a **Secretary Bots** privilege class — *after* the assistant's Jan-2026 knowledge cutoff. The earlier working assumption that "bots can never see other bots' messages, so bot-to-bot is impossible" is **outdated**. The verification pass killed the absolute-restriction claims and confirmed the new capabilities against official `core.telegram.org` pages. The user's premise was correct.

The nuance that survives: these are **opt-in, gated** capabilities layered on top of a still-true default (bots don't see other bots by default). So "real" ≠ "frictionless."

## 1. What is actually true (verified, cited)

### Default rule (still true)
- **Bots do not see messages from other bots by default** — confirmed (3-0). *"On Telegram, bots generally cannot see messages from other bots. However, in specific contexts, Bot-to-Bot communication is allowed."* — `core.telegram.org/bots/features`

### Bot-to-bot communication (NEW, Bot API 10.0) — mechanics VERIFIED 2026-06-28
- **One bot can send a message to another bot via username — only if BOTH bots enable bot-to-bot communication** (mutual opt-in). Confirmed (2-1). *"Added the ability to send messages to other bots via username if both bots enabled bot-to-bot communication."* — `core.telegram.org/bots/api` + `/bots/api-changelog`
- **A business bot can reply to other bots — again only if it enabled bot-to-bot communication.** Confirmed (3-0). Same sources.
- **Enablement:** a BotFather per-bot toggle — *"Make sure Bot-to-Bot Communication Mode is enabled for your bot in @BotFather."* Empirically confirmed in BotFather → Bot Settings (2026-06-28). (This supersedes the earlier "configuration mechanism unverified" caveat — it IS BotFather.)
- **Send mechanics** (`core.telegram.org/bots/features`):
  - *Private:* *"Bots can send private messages to other bots by passing their `@username` to the sendMessage method."*
  - *Groups:* mention via `/command@OtherBot` or reply to the bot's message; and a bot that is **admin or has Group Privacy Mode disabled** *"will receive all messages from other bots in groups without explicit mentions or replies."*
  - *Business accounts:* a bot connected via *Chat Access Mode* can message other bots used by that business account.
- **Receive mechanics:** the receiving bot gets these through the **standard update mechanism — NO new `Update` type and NO new `Message` field** (confirmed against `core.telegram.org/bots/api`). Enabling the mode simply lifts the default exclusion of "messages sent by other bots," so a normal `message` update (`from.is_bot=true`) is delivered when both ends have the mode on.
- **Loop safety is the developer's responsibility:** *"Bot-to-bot communication can easily result in infinite interaction loops. When enabling this feature, you must implement safeguards"* — deduplication, rate limiting, maximum interaction depth. No built-in guard.

### Secretary Mode / Secretary Bots (NEW)
- **Secretary Mode lets a user connect a bot to their personal account** so it can process incoming messages and respond on their behalf — a capability a normal bot lacks. Confirmed (3-0). *"…allowing users to connect them to their account … process incoming messages and even respond on their behalf … the bot will receive all updates normally supported by the Bot API, except messages sent by itself and other bots … may also send messages … on behalf of the account owner in chats that were active in the last 24h."* — `core.telegram.org/bots/features`
  - **Critical:** a Secretary-Mode bot **explicitly does NOT receive messages from other bots.** So Secretary Mode is *not* a fleet-orchestration channel — it is a bot acting for a **human** account.
- **Secretary Bots are a privilege class** that (API 10.0) may manage accounts of users **without** Telegram Premium. Confirmed (2-1). *"Allowed Secretary Bots to manage accounts of users without a Telegram Premium subscription."* — `core.telegram.org/bots/api`. Documented via the features page + changelog lines; **no dedicated API object/method** is defined for the term (the "no standalone object" point was confirmed, 0-3 against the claim that it's a versioned changelog feature).

### Business connection constraints
- **Only ONE business bot may be connected to a user account at a time** — confirmed (3-0). *"Currently just one business bot may be connected to a user account."* — `core.telegram.org/api/bots/connected-business-bots`. ⇒ **No multi-bot fan-in under a single human account** at the business-connection layer.
- A connected business bot **acts on behalf of the user account** (process/answer messages, integrate tools / AI assistants). Confirmed (3-0). It receives `updateBotNewBusinessMessage` / `Edit` / `Delete` for messages to the **connected human user** — it observes a human's conversation, not other bots' messages. — `core.telegram.org/api/business`

### Inline mode
- A bot can be invoked from the text input of **any** chat by typing its username + a query — **user-triggered, not bot-triggered** cross-chat invocation. Confirmed (3-0). — `core.telegram.org/bots/inline`

### Killed / low-confidence
- "Bots cannot receive messages from other bots under ANY configuration / bot-to-bot topology not permitted" — **killed** (the 10.0 opt-in capability refutes the absolute form).
- Secondary-source claims about an "autonomous bot-to-bot mini-app toggle" — **abstained (0-0)** when the session limit cut verification short; treat as directionally consistent but unconfirmed.

## 2. Reconciliation with our codebase

Our platform **already coordinates the multiple LLMs below the presentation layer** (see companion doc):
- heterogeneous-provider children spawned via `buildChildConfig` + `src/providers/factory.ts`;
- coordinated through a **shared WAL blackboard** (`SharedBlackboard.publish`, `src/fleet/shared-blackboard.ts:73`) in **rounds with early-stop** (`FleetCoordinator.executeRounds`, `src/fleet/coordinator.ts:54`);
- merged by a **pure offline synthesis** (`collect`, `src/fleet/synthesis.ts:28`).

So we already have a deterministic, offline, rate-limit-free "secretary + inter-agent exchange." Telegram bot-to-bot would be a **second, network-dependent, non-e2e, rate-limited bus** doing what the blackboard already does correctly.

## 3. Recommendation — topology for the Telegram frontend

**Do NOT make the multiple LLMs coordinate by talking to each other over Telegram.** Coordination already lives in the blackboard. Use Telegram for what it is good at: the **human ↔ platform** surface. Three tiers, in priority order:

### Tier 1 — RECOMMENDED (enrich spec #8 with this)
**One bot, "secretary" presentation capability over the existing fleet artifacts.** The single control-plane bot (spec #8 spine) **reads the blackboard + `fleet-synthesis.json`** and:
- surfaces each LLM/agent's findings as **labeled sections** (you see "what each of the multiple LLMs is doing" through one bot);
- **streams** fleet round progress by editing one status message (spec feat-8a);
- pushes **silent digests** (feat-8b).
- Zero new platform complexity, one bot token, stays entirely inside spec #8's `sendSafe` privacy funnel. This delivers the user's actual goal — "make the multi-LLM platform easier to use" — without a second coordination bus.

### Tier 2 — OPTIONAL axis (opt-in flag; likely its own sibling spec, not folded into #8)
**Per-LLM bot identities via Bot API 10.0 bot-to-bot**, *only if* you specifically want each LLM addressable as its own Telegram identity (DM "the medical bot"; see distinct bots in a group). A dispatcher/secretary bot messages worker bots and receives replies — now genuinely possible. **Costs to accept:** N bot tokens, **mutual opt-in enablement per bot pair**, bots-don't-see-bots by default, Telegram rate limits, and **redundancy with the blackboard**. Worth it for *UX of distinct identities*, never for coordination *correctness*. Crosses spec #8's `outOfScope` line 153 → treat as a separate spec.

### Tier 3 — SEPARATE concern (defer; explicit-consent spec of its own)
**Secretary Mode (bot acting on YOUR user account)** could power "auto-ingest my real incoming Telegram DMs into the task inbox." But it turns the bot into a **reader of your human chats** — a large expansion of the egress/privacy surface that directly tensions spec #8's control-plane / PHI boundary, and is capped at **one business bot per account**. Do not fold into #8; if wanted, spec it separately with a first-class consent design.

## 4. Concrete edits this implies for spec #8

- **Keep** the thin single-bot, long-polling, whitelist, `sendSafe`-funnel spine **unchanged**.
- **Extend feat-8** (already "streaming + silent digest") to explicitly read the **blackboard / `fleet-synthesis.json`** as a delivery source, rendering **per-agent (per-LLM) labeled summaries** — this is the "secretary" view.
- **Add a clarification/`outOfScope` note** recording the validated decision: bot-to-bot (Tier 2) and Secretary Mode (Tier 3) are **deliberately deferred** to sibling specs, with the API-10.0 evidence cited, so the boundary is a documented choice rather than an omission.
- **No new dependency** beyond the one Telegram library already budgeted — pick a library whose version supports Bot API 10.0 if Tier 2 is ever pursued.

## 5. Before building — status (mechanics resolved 2026-06-28)

1. ~~How bot-to-bot is enabled~~ — **RESOLVED.** Per-bot BotFather toggle "Bot-to-Bot Communication Mode" (empirically confirmed in BotFather → Bot Settings + features page). Enable by hand on each bot.
2. ~~Receive/send transport + library support~~ — **RESOLVED.** No new `Update` type or `Message` field (verified against `core.telegram.org/bots/api`); send is `sendMessage(@username)` (private) / mention-or-reply (group) / Chat Access Mode (business); receive is a normal `message` update with `from.is_bot=true`. ⇒ Any maintained Node library works **provided it does not drop `is_bot` messages** and lets you address a `@username` — the only remaining library check, and a minor one.
3. **Group reception requires the bot to be admin OR have Group Privacy Mode disabled** to receive un-mentioned bot messages — a deployment detail for any group-based dispatcher topology (Tier 2).
4. **Loop safeguards are mandatory and self-implemented** (dedup, rate limit, max interaction depth) — Tier 2 must build these; the fleet already has bounded rounds (`BLACKBOARD_MAX_ROUNDS=3`) as a model.
5. **Minor open check:** the BotFather toggle caption scopes bot-to-bot to "groups and via business accounts," while the features page also documents private-chat sending by `@username`. Confirm empirically which contexts your bots actually use before relying on private bot↔bot.
6. **Secretary Mode (Tier 3 only):** confirm the exact consent/permission scoping (which chats; the 24h active-window send rule) if ever pursued.

## 6. Next step

Run `/bober-plan` (or `/bober-architect`) to **enrich spec #8** with the Tier-1 secretary-view extension and the deferral notes above — using this doc and the companion codebase doc as the cited evidence base.

---

*External findings verified by the `/deep-research` adversarial harness (3-vote); the topology synthesis is authored here because the harness's synthesis step was cut short by a session limit. Confidence is flagged per claim; §5 lists what to confirm before implementation.*

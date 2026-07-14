# Research — Interconnected AI Knowledge Platform (landscape + what to add)

- **Date:** 2026-06-27
- **Source:** `/deep-research` (107 agents, 25 sources, 121 claims → 23 verified / 2 refuted) + internal `tokensave` inventory of agent-bober.
- **Decisions locked with user:** Storage = **Hybrid** (medical/financial local-first; coding/project research may live in cloud). Sharing = **Shared git repos**. First deliverable = **one domain end-to-end** → **Medical** is the template; Financial is the copy-target.

---

## 1. The flow (recommended architecture)

```
            ┌─────────────────────────────────────────────────────┐
            │  kb-hub  (unified repo — the "what's ASAP" judge)    │
            │  • aggregates findings/tasks across all domain repos │
            │  • priority judge  (reuse fleet synthesis + lens)    │
            │  • scheduler  (recurring multi-model research)       │
            └───────────▲───────────▲───────────▲─────────────────┘
                        │           │           │   (git submodules / sibling clones,
                        │           │           │    each pulled into the hub on a run)
        ┌───────────────┴──┐ ┌──────┴───────┐ ┌─┴────────────────┐
        │ kb-medical       │ │ kb-financial │ │ kb-projects       │
        │ LOCAL-FIRST      │ │ LOCAL-FIRST  │ │ cloud-OK          │
        │ SOPS-encrypted   │ │ SOPS-encrypt │ │ (Notion/Obsidian) │
        │ Team: medical-sop│ │ Team: (new)  │ │ Team: (new)       │
        └──────────────────┘ └──────────────┘ └───────────────────┘
              each repo = an agent-bober **Team** (data, not code):
              memoryNamespace + pipelineShape + providers + guardrails
```

**Each domain is an agent-bober `Team`** (already supported — `TeamConfigSchema`). A team is *data*, so a new domain = a config + a repo, not new code. Sensitive teams run local-first with zero-egress (medical already does); non-sensitive teams may sync to cloud KBs.

**Storage format inside each repo:** flattened **SQLite (via the existing `FactStore`) + markdown-with-frontmatter**, NOT raw FHIR. Research finding: the best LLM agent scores only **50% answer-correctness querying raw FHIR** (nested graph shape) — flattened/tabular and markdown-frontmatter are materially more AI-reliable. Keep FHIR / Apple Health export as the *import source*; flatten on ingest (you already do this for meds → FactStore).

**AI consumes each repo** through the two **maintained official** MCP servers — **Filesystem** and **Git** — plus agent-bober's own internal FactStore querying. (You do **not** need the archived SQLite/Postgres MCP servers — see §2.)

---

## 2. External landscape — verified findings + fit

Legend: ✅ verified (≥2/3 adversarial votes) · 🔎 lead (surfaced in search, NOT independently verified — treat as a pointer) · ❌ refuted.

### Angle 1 — Local-first MCP data-store servers

| Tool | Status | Verdict | Fit for us |
|---|---|---|---|
| **Filesystem** MCP (official, maintained) | ✅ | Official reference server | Use as the read/write surface over each repo. |
| **Git** MCP (`mcp-server-git`, Anthropic, 12 tools) | ✅ | Official, maintained | Makes a git-backed KB directly LLM-queryable/editable — the backbone of the shared-git model. |
| SQLite / Postgres / Redis / GDrive reference servers | ✅ | **Archived 2025-05-29, read-only, no security fixes** | **Do not adopt.** The official Postgres server v0.6.2 has a live **SQL-injection** hole (stacked `COMMIT; DROP SCHEMA…` escapes the read-only txn — demonstrated to delete all tables via ordinary chat). Use your own `FactStore` for SQL instead. |
| **cyanheads/obsidian-mcp-server** (14 tools) | ✅ | Mature **community** | If you keep an Obsidian vault: read/write/search/surgical-frontmatter edits. |
| **Obsidian Local REST API** plugin (now ships built-in MCP, v4) | ✅ | Mature **community** | Full CRUD + heading/block/frontmatter patching at `127.0.0.1:27124`, bearer-token auth. Third-party bridges no longer needed. |
| **Nooscope** (on-device semantic Obsidian search) | 🔎 | Community lead | On-device vault semantic search, no cloud routing. |

### Angle 2 — Cloud knowledge-base connectors (non-sensitive side of hybrid)

| Tool | Status | Verdict | Fit |
|---|---|---|---|
| **Notion** official MCP (`makenotion`, 22 tools) | ✅ | Official | Read (as token-efficient Markdown) + write pages/DBs/comments. ⚠️ Hosted OAuth path is **not for unattended agents** — autonomous agent-bober runs need the **local server + manual `NOTION_TOKEN`**. |
| **Google** managed remote MCP (BigQuery/Maps/GCE/GKE, Dec 2025) | ✅ | Official, Google-hosted | BigQuery server queries structured data **in-place** (only results enter context). Useful if financial/project data ever lands in BigQuery. |
| Airtable / community GDrive servers | — | Not verified | Out of scope of surviving evidence. |

### Angle 3 — Structuring MEDICAL data for LLM ingestion (the template)

| Finding | Status | Implication |
|---|---|---|
| **LLMonFHIR** (Stanford, MIT, physician-validated) ingests Apple HealthKit FHIR via scoped function-calls | ✅ | Concrete reference architecture for personal-health Q&A. |
| Raw **FHIR** → best agent only **50% correct** on realistic QA | ✅ | **Flatten on ingest.** Don't make raw FHIR your primary AI store. |
| **Claude parses lab-report PDFs → versioned structured JSON** (markers, SI units, reference ranges, status flags incl. critical) **without OCR** | ✅ | This is your **lab-ingestion path** — base64 the PDF as a `document` block, emit structured JSON, write to FactStore. (Caveat: scanned/image PDFs still need OCR first.) |
| **Open Wearables** API (WHOOP/Garmin/Polar/Suunto/Apple Health over MCP) + Momentum **Apple Health MCP** | 🔎 | Leads for broadening wearable import beyond your existing WHOOP+Apple Health. Not independently verified — evaluate before adopting. |

### Angle 4 — Multi-model judge + scheduled research

> ⚠️ **This angle produced ZERO verified claims** — treat the web side as *unresearched*, not as "nothing exists." Leads only:

| Tool | Status | Note |
|---|---|---|
| **LiteLLM** | 🔎 | Self-hosted OSS router/proxy — fits local-first; candidate for the model-routing layer if you want one beyond your own fleet routing. |
| **OpenRouter** | 🔎 | Hosted router — easier, but a third party sees prompts (bad for sensitive domains). |
| **DeepEval** | 🔎 | LLM-as-judge eval framework. |

**Key point:** you don't actually need external judge tooling — **you already have the judging substrate internally** (fleet tier→provider routing, SharedBlackboard, lens-panel). "We have that set up, just need to test it" is accurate.

### Angle 5 — Privacy in a shared git repo

| Tool | Status | Verdict |
|---|---|---|
| **SOPS** | ✅ | **The one survivor.** Value-level encryption: keys stay plaintext, values encrypted → diffs stay meaningful and structure stays AI-readable while secrets are hidden. Backends: age, GPG, AWS/GCP/Azure KMS. **Recommended for the sensitive repos.** |
| **git-crypt** | ❌ | Specific capability claim **refuted (0-3)** — don't rely on the unverified claims; evaluate fresh if considered. |
| age / transcrypt / Syncthing / "second-brain repo" patterns | 🔎 | Surfaced but unverified. Syncthing remains the obvious P2P option for large binary exports (scans) that shouldn't live in git. |

---

## 3. The 3 genuinely net-new pieces (everything else is substrate)

~70% of the vision already exists in agent-bober (FactStore, Teams-as-data, fleet multi-provider + blackboard + lens judging, chat + interrupt/approve/steer, medical module with Apple Health/WHOOP/MedlinePlus). The net-new work:

1. **Unified priority hub** — aggregate findings/tasks across domain repos and judge "what's ASAP."
   - *Reuse:* fleet `synthesis.collect()` (already aggregates a run's blackboard → `fleet-synthesis.json`) + `lens-panel` for the judge. *Net-new:* the cross-**repo** collector + a priority schema + ranking prompt.

2. **Scheduler for recurring multi-model research.**
   - *Reuse:* harness-level cron (`/schedule`, `CronCreate`) to fire `bober run` / `fleet` / `chat` on a cadence; model diversity via existing fleet tier→provider routing (LiteLLM only if you want a router abstraction). *Net-new:* a thin "research job" config (question + cadence + model set + target repo).

3. **Medical template completion** — lab ingestion + encrypted shared git.
   - *Net-new:* (a) lab-PDF → structured-JSON → FactStore importer (Claude `document` block, schema from §2); (b) SOPS wiring on `kb-medical` values so the repo is shareable without leaking PHI.

---

## 3a. Unified hub — detailed design (refined with user 2026-06-27)

**Repo layout:** sibling clones (NOT git submodules); the hub reads each domain's FactStore read-only and writes `priority.md` / `schedule-plan`.

```
~/kb/  agent-bober/ · kb-medical/ · kb-financial/ · kb-projects/ · kb-hub/
```

**Priority is query-scoped, not a fixed global ranking.** Collect ALL findings/tasks into one pool, then rank relative to the question asked:
- **decision mode** — "I'm deciding between X and Y" → relevance-filter to X/Y, drop unrelated, rank within frame.
- **general mode** — "what should I do?" → broad rank (optional time horizon).
- **filtered mode** — scope by domain / due-window / tag.
Mechanics: two-pass **lens-panel** (pass 1 relevance-filter against stated scope, pass 2 rank). Scope is **ephemeral per question** (stated in chat, not stored). Reuses existing judging substrate.

**Common Finding schema** (one stream the hub ranks):
```
Finding { id, domain, title, kind: action|watch|risk|question,
  urgency 1-5, severity 1-5, evidence[], surfacedAt, dueBy?,
  tags[], estDurationMin?, calendarSafeTitle?, status, promotesTo? }
```

**Task inbox** (both sources): (a) auto-surfaced findings from each domain pipeline; (b) a **plain task inbox** — type "renew passport" → lands as `kind: action`. Rides on FactStore machinery already shipped: `reconcileFact`/`FactJudge` = dedup + edit; `supersedeFact` (bitemporal) = complete/drop without losing history.
- **UX rule 1 — capture is zero-friction, enrichment is lazy:** `bober task add "…"` succeeds with NO required fields; AI infers what it safely can, leaves unknowns (e.g. `dueBy`) null, NEVER blocks capture with a question; unknowns picked up in a later triage pass.
- **UX rule 2 — tasks live in the hub pool by default**, optional `domain` tag; domain pipelines write to their domain AND bubble up.
- **Status lifecycle:** open → in-progress → **snoozed** (v1, included) → done/dropped. Completion = supersede.
- **Do-bridge (v1):** `promotesTo` field makes a task launch real work. Wire ONE path as proof — **coding task → `bober run`/`fleet`** (strongest existing muscle). Financial/medical do-bridges later. Promotion goes through the approve-gate.
- New commands (mirror `bober memory`): `bober task add|list|done|snooze|drop`. Bonus (connectors already live): "turn this Gmail thread into a task."

**Calendar planner (time-aware):** LLM ranks → **deterministic JS** slot-fill against real free/busy (respect `dueBy` + `estDurationMin` + priority order — do NOT let the LLM pack slots) → **propose → /approve → write** (existing interrupt/approve/steer gate). Connector = **claude.ai Google Calendar MCP** (verified present in env; OAuth-gated via `/mcp`, real event tools surface post-auth — i.e. *connect an existing* calendar, not build one). Caveat: hosted OAuth isn't built for unattended cron → scheduled "auto-fill" needs a local-token path or the **`.ics` fallback** (keep the planner connector-agnostic). Privacy: cloud events use non-sensitive `calendarSafeTitle`; sensitive "why" stays local.

**Telegram frontend (presentation adapter — sequences AFTER hub+inbox exist):**
- **Long-polling (`getUpdates`)** → no server, no public URL, no open port; bot runs locally. Each person runs their own bot vs their own agent-bober. (Webhooks rejected — need public HTTPS.)
- **Security = user-ID whitelist** (`TELEGRAM_ALLOWED_USERS`); non-listed → access denied + ID echoed. You + 2nd person = two IDs.
- **Mapping (no new logic):** text → task capture; `/today` `/priority` `/decide X vs Y` → scoped prioritization; **inline buttons** [✅ Approve]/[✏️ Adjust]/[❌ Reject] → existing approve/steer gate; **document upload** → medical ingest; streaming → live run progress; **silent scheduled messages** (new May-2026) → scheduler's morning digest.
- **Privacy rule (critical):** Telegram bot messages are **NOT end-to-end encrypted** (no secret chats for bots) → bot is a **control plane + notifications + non-sensitive summaries ONLY**, never a conduit for raw PHI/financial detail. Lab-PDF-via-Telegram = explicit per-upload opt-in, not default. Same boundary as the cloud calendar.
- Useful new features from telegram.org/blog/ai-bot-revolution-11-new-features: streaming-for-bots, silent scheduled messages, bot-to-bot (future autonomous chaining).

---

## 4. Medical template — concrete end-to-end (ingest → store → analyze → chat)

1. **Ingest** — `bober medical import` already does Apple Health (SAX) + WHOOP. **Add:** `bober medical import-labs <pdf>` → Claude document-block → versioned JSON (markers/SI/ranges/flags) → FactStore. Supplements: a simple markdown-frontmatter list flattened into FactStore.
2. **Store** — FactStore (SQLite) for structured markers + meds + supplements; markdown-with-frontmatter for narrative/context. `kb-medical` repo, local-first, SOPS-encrypted values, zero-egress default (already enforced).
3. **Analyze** — `medical-sop` pipelineShape with its 5 code-enforced guarantees (consent fail-closed, red-flag short-circuit, deterministic numerics, abstain-unless-cited, grounding-critic gate). "What do we need / why" = grounded synthesis over the FactStore.
4. **Chat** — `bober chat medical` (existing chat + interrupt/approve/steer) pointed at the medical team.
5. **Share** — second person clones `kb-medical` + `agent-bober`; SOPS key handed over out-of-band; both run locally.

Financial then **copies this template**: new Team config, same FactStore + SOPS + chat surface; ingest path swaps lab-PDF parsing for statement/CSV parsing (Plaid etc. — research separately, not covered here).

---

## 5. Honest gaps in this research (don't over-trust)

- **Angle 4 (multi-model judge / scheduler external tooling) = unresearched** — no claim survived verification. Mitigated because the judging substrate is internal.
- **Wearable importers (WHOOP/Oura/Fitbit) & lab-vendor exports (Quest/LabCorp) not verified** — only Apple HealthKit/FHIR + generic Claude-PDF parsing are evidenced.
- **Privacy angle thin** — only SOPS survived; age/transcrypt/Syncthing/second-brain patterns unverified; git-crypt refuted.
- **Time-sensitivity** — MCP ecosystem moves fast; archived-server list accurate mid-2025→2026-06-27; Google managed servers are Dec-2025-new; Notion tool count is the self-hosted 22 (hosted variant ~18).

---

## 6. Recommended next steps (per-domain doc sets)

1. **Run `/bober-plan` on the Medical end-to-end template** (the 3 net-new medical pieces in §3.3 + §4) → sprint contracts. This is the reusable template; do it first.
2. Then **`/bober-research` or `/bober-plan` on the Unified Priority Hub** (§3.1) — depends on having ≥1 real domain repo to aggregate.
3. Scheduler (§3.2) is small — fold into the hub plan or its own 1–2 sprint plan.
4. Financial domain = repeat (1) with the template proven; research Plaid/statement-ingestion separately.

# Sprint Briefing: Scoped prioritization commands (/today, /priority, /decide X vs Y)

**Contract:** sprint-spec-20260628-telegram-frontend-3
**Generated:** 2026-06-30T00:00:00Z

> Thin presentation adapter. This sprint adds `/today`, `/priority`, and `/decide X vs Y`:
> parse an EPHEMERAL per-question `Scope` from the command text, call the EXISTING priority
> hub with it, and reply with a numbered ranked list of finding titles through `sendSafe`.
> No persistence, no re-ranking, no LLM reasoning in the adapter — the hub owns ranking.

---

## 1. Target Files

### `src/telegram/router.ts` (modify)

Currently a PURE classifier (no side effects, no clock). The Sprint adds a PURE scope
parser here (recommended home — fits the file's "pure parsing" charter and explains why
router.ts is a modify target). Existing surface the dispatch already uses:

```ts
// src/telegram/router.ts:10-12 — discriminated union returned by classify()
export type RoutedMessage =
  | { kind: "command"; name: string; args: string }
  | { kind: "text"; text: string };

// src/telegram/router.ts:29-40 — classify(): "/decide A vs B" -> {kind:"command", name:"decide", args:"A vs B"}
export function classify(message: string): RoutedMessage {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("/")) {
    const body = trimmed.slice(1);
    const sp = body.search(/\s/);
    const name = sp === -1 ? body : body.slice(0, sp);
    const args = sp === -1 ? "" : body.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  return { kind: "text", text: message };
}
```

**ADD here** a pure exported parser, e.g. `parseScopeFromCommand(name: string, args: string): Scope | null`
that returns `null` for non-prioritization commands (so the dispatch can fall through to
"Unknown command"). Import `Scope` via `import type { Scope } from "../hub/scope.js"`.

**Imports this file uses:** none today (pure). New: `import type { Scope } from "../hub/scope.js";`
**Imported by:** `src/telegram/bot.ts:11` (`import { classify } from "./router.js"`).
**Test file:** `src/telegram/router.test.ts` exists (vitest, see §6).

---

### `src/telegram/bot.ts` (modify) — extend the command-dispatch block

The EXACT block to extend is the command branch inside the poll loop:

```ts
// src/telegram/bot.ts:146-157 — current dispatch (the generator inserts /today,/priority,/decide here)
const routed = classify(text);
if (routed.kind === "command") {
  // Command dispatch: /start → help; everything else is a stub for Sprints 3-4.
  // bober: single-level command switch; replace with a command registry map
  //        when Sprint 3+ adds real commands (hub/inbox/calendar queries).
  const reply = routed.name === "start" ? helpReply() : `Unknown command: /${routed.name}`;
  await sendSafe(transport, chatId, reply);
} else {
  // Plain text → zero-friction capture via the injected inbox sink.
  const reply = await handleCapture(routed.text, capture);
  await sendSafe(transport, chatId, reply);
}
```

**How to extend (mirror the `capture` injection at bot.ts:105):** add a `prioritize: PrioritizeFn = defaultPrioritize`
parameter to `startPollLoop` (bot.ts:102-106), and in the command branch route
`today | priority | decide` to `await handlePrioritize(routed.name, routed.args, prioritize)`,
then `await sendSafe(transport, chatId, reply)`. Keep `/start → helpReply()` and the
`Unknown command` fallback for everything else.

**Invariant (bot.ts:96-97, nonGoal #2 of outbound):** the loop NEVER calls
`transport.sendMessage` directly — every reply goes through `sendSafe`.

**Imports this file uses (bot.ts:6-13):** `Bot` from `grammy`; `sendSafe`/`TelegramTransport`
from `./outbound.js`; `classify` from `./router.js`; `handleCapture`/`defaultCapture`/`InboxCapture`
from `./handlers/capture.js`. Add: `handlePrioritize`/`defaultPrioritize`/`PrioritizeFn` from `./handlers/prioritize.js`.
**Test file:** no `bot.test.ts` (loop tested indirectly; outbound.test.ts covers sendSafe).

---

### `src/telegram/handlers/prioritize.ts` (create)

**Directory pattern:** `src/telegram/handlers/` uses kebab/lowercase file names; one handler
per file with a co-located `*.test.ts`. Only existing sibling: `capture.ts`.
**Most similar existing file:** `src/telegram/handlers/capture.ts` — MIRROR its
injected-sink + `defaultX` pattern exactly (see §2 Pattern A).

**Structure template (based on capture.ts + chat-session.ts:527-543):**
```ts
// src/telegram/handlers/prioritize.ts
import type { Scope } from "../../hub/scope.js";
import type { Finding } from "../../hub/finding.js";

/** Injected hub-query. Production default ranks via the hub; tests pass a fake. */
export type HubQuery = (scope: Scope) => Promise<Finding[]>;

/** Production HubQuery — see §3 for the two valid implementations (import vs execa). */
export async function defaultPrioritize(scope: Scope): Promise<Finding[]> { /* …§3… */ }

/** Pure: render the hub's findings as a numbered list — ORDER PRESERVED VERBATIM (no re-rank). */
export async function handlePrioritize(
  name: string,
  args: string,
  query: HubQuery = defaultPrioritize,
): Promise<string> {
  const scope = parseScopeFromCommand(name, args); // from router.ts (or local)
  if (scope === null) return `Unknown command: /${name}`;
  const ranked = await query(scope);
  if (ranked.length === 0) return "No findings to prioritize.";
  return ranked.map((f, i) => `${i + 1}. ${f.title}`).join("\n"); // title only — see §4
}
```

### `src/telegram/handlers/prioritize.test.ts` (create)
Co-located vitest, mirror `capture.test.ts`. See §6 for the full injected-fake template.

---

## 2. Patterns to Follow

### Pattern A — Injected dependency + `defaultX` wrapper (THE core pattern to mirror)
**Source:** `src/telegram/handlers/capture.ts:18`, `:35-46`, `:60-63`
```ts
// :18  injected dependency type
export type InboxCapture = (text: string) => Promise<{ id?: string; title: string }>;

// :35-46  production default: constructs real deps (store/clock), calls the hub export, closes
export async function defaultCapture(text: string): Promise<{ id?: string; title: string }> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  await ensureFactsDir(projectRoot);
  const now = new Date().toISOString();          // clock at BOUNDARY, never inside hub code
  const store = new FactStore(factsDbPath(projectRoot));
  try {
    const f = await captureTask(store, text, { now });
    return { id: f.id, title: f.title };
  } finally {
    store.close();
  }
}

// :60-63  pure handler takes the injected fn — no transport, returns a string for sendSafe
export async function handleCapture(text: string, capture: InboxCapture): Promise<string> {
  const { title, id } = await capture(text);
  return id !== undefined ? `Captured: ${title} (#${id})` : `Captured: ${title}`;
}
```
**Rule:** Handler is pure and transport-free; it takes an injected dependency fn (default =
`defaultX`). `defaultX` is the ONLY place that constructs real stores/clients. Tests pass a fake.

### Pattern B — Hub "decide X vs Y" parse + rank + render (DIRECT prior art to copy)
**Source:** `src/chat/chat-session.ts:507-543`
```ts
// :511-520  split on /\s+vs\s+/i, trim both, build a decision Scope via parseScope
const parts = expr.split(/\s+vs\s+/i);
if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) return `Expected 'X vs Y', got: ${expr}`;
const scope = parseScope({ mode: "decision", optionA: parts[0]!.trim(), optionB: parts[1]!.trim() });

// :527-542  collect → rank → render numbered list; ORDER IS THE HUB'S ORDER (no re-sort)
const findings = collectFindings(siblings, HUB_SCOPE);
const ranked = await rankFindings(findings, scope, this.llm, now);
return ranked.map((f, i) => `${i + 1}. ${f.title}`).join("\n");
```
**Rule:** `/decide` splits on the literal ` vs ` (case-insensitive via `/\s+vs\s+/i`), trims both
options, rejects ≠2 options. The reply is `ranked.map((f,i) => \`${i+1}. ${f.title}\`)` — copy this
exactly; do NOT re-rank or re-sort.

### Pattern C — CLI hub command prints the same numbered format
**Source:** `src/cli/commands/hub.ts:152-154`
```ts
for (let i = 0; i < ranked.length; i++) {
  process.stdout.write(`${i + 1}. ${ranked[i]!.title}\n`);  // ← execa fallback parses these lines
}
```
**Rule:** `agent-bober hub priority` / `hub decide` stdout is `N. <title>` lines — the execa
fallback (§3c) parses exactly this.

### Pattern D — ESM `.js` imports + `import type`
**Source:** `src/telegram/handlers/capture.ts:7-9`, `src/cli/commands/hub.ts:24,27,31`
```ts
import { captureTask } from "../../hub/task-inbox.js";       // runtime import, .js suffix
import type { Finding } from "../../hub/finding.js";         // type-only import
import { type Scope, parseScope } from "../../hub/scope.js"; // inline type import
```
**Rule:** NodeNext ESM — every relative import ends in `.js`; types use `import type` / inline `type`. No `any`.

---

## 3. Hub Query Surface — the load-bearing decision (per Q1 hybrid rule)

The generatorNotes say: *"default imports the hub query export if present, else execa `agent-bober` hub command."*
Both surfaces exist and are pinned below. The injected handler type is
`HubQuery = (scope: Scope) => Promise<Finding[]>`; only `defaultPrioritize`'s body differs.

### (a) The importable hub export — `rankFindings` (RECOMMENDED default; matches chat-session precedent)
**Path/signature:** `src/hub/judge.ts:174-179`
```ts
export async function rankFindings(
  findings: Finding[],
  scope: Scope,
  llm: LLMClient,
  now: Date,
): Promise<Finding[]>;   // returns ranked Finding[]; order is the hub's order (LLM never emits final order)
```
`rankFindings` does NOT take a store — it takes an already-collected `findings: Finding[]` pool.
To build that pool + the LLM client, mirror `src/cli/commands/hub.ts:215-237` and
`src/chat/chat-session.ts:527-531` exactly:
```ts
// defaultPrioritize body (Option A — in-process, mirrors hub.ts:215-237 / chat-session.ts:527-531):
import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { resolveRoleProviders } from "../../config/role-providers.js";
import { createClient } from "../../providers/factory.js";
import { resolveSiblingRepos } from "../../hub/repo-resolver.js";
import { collectFindings } from "../../hub/collector.js";
import { HUB_SCOPE } from "../../hub/finding-source.js";
import { rankFindings } from "../../hub/judge.js";

const projectRoot = (await findProjectRoot()) ?? process.cwd();
const config = await loadConfig(projectRoot);
const providers = resolveRoleProviders(config);
const client = createClient(                                  // factory.ts:192 signature
  providers.chat, config.chat?.endpoint ?? null,
  config.chat?.providerConfig, config.chat?.model, "chat",
);
const siblings = await resolveSiblingRepos(projectRoot);
const findings = collectFindings(siblings, HUB_SCOPE);        // collector.ts:16 — pure, read-only
return rankFindings(findings, scope, client, new Date());     // hub owns the model calls
```
- `Scope` input type — `src/hub/scope.ts:13-16` (full quote in §4).
- `Finding` return type — `src/hub/finding.ts:10-27` (full quote in §4).
- **nonGoal #5 note:** "the hub owns any model calls" is satisfied because `rankFindings`
  (hub code) is what calls `llm.chat`; the adapter only supplies the client — identical to how
  the chat adapter does it at `chat-session.ts:531`. The adapter does NO independent model reasoning.

### (b) Store construction — there is NO store argument to the query
Unlike `captureTask` (which took a `FactStore`), `rankFindings` takes a plain `Finding[]`.
The pool is built read-only by `collectFindings(repoPaths, HUB_SCOPE)` (`src/hub/collector.ts:16-40`),
which opens each sibling's facts.db `{ readonly: true }` and dedups by `Finding.id`. No FactStore
is opened for writing anywhere in this handler (ephemeral — see §nonGoal/6).

### (c) The execa CLI fallback (documented alternative — fullest process isolation of the LLM)
**Commands (binary = `agent-bober`, package.json:8-9):**
- `/priority` → `agent-bober hub priority`            (general scope) — `src/cli/commands/hub.ts:206-246`
- `/today`    → `agent-bober hub priority --due 1`    (filtered/dueWithinDays scope) — `hub.ts:210,228-234`
- `/decide`   → `agent-bober hub decide "X vs Y"`     (decision scope) — `src/cli/commands/hub.ts:250-293`

stdout is `N. <title>` lines (`hub.ts:152-154`). execa is a dep (`execa@^9.5.2`, package.json:68).
Real execa template (`src/graph/cli.ts:43-63`): `await execa(binary, args, { cwd, reject:false, all:true })`,
then check `result.exitCode`, parse `result.stdout`. NOTE: execa output is title-only (no Finding
objects) — acceptable because the reply renders titles only anyway (§4). If you choose execa, have
`defaultPrioritize` parse `^\d+\.\s(.+)$` lines into `{ title }`-only objects.

> **Recommendation:** use Option A (import `rankFindings`) as the default — it is the established
> in-process precedent (`chat-session.ts:531`, `hub.ts:144`), returns real `Finding[]`, and keeps
> the injected `HubQuery` type returning canonical `Finding[]`. Document execa as the hybrid fallback.

---

## 4. Finding & Scope shapes — render TITLE ONLY

### Canonical `Finding` (the hub OWNS this — do NOT redefine)
**Source:** `src/hub/finding.ts:10-27`
```ts
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),          // ← THE one-line label to render
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),     // ← DO NOT render (nonGoal #3: no raw domain detail)
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),
  tags: z.array(z.string()),
  estDurationMin: z.number().int().optional(),
  calendarSafeTitle: z.string().optional(),
  status: z.enum(["open","in-progress","snoozed","done","dropped"]),
  promotesTo: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
```
**CRITICAL:** there is **NO `summary` field** on `Finding` (grep-confirmed). The "one-line summary"
in the contract/generatorNotes is the **`title`**. Render `${i+1}. ${f.title}` (mirrors
chat-session.ts:542 and hub.ts:153). If you want a one-line suffix, the only control-plane-safe
fields are `kind`/`urgency`/`severity` (e.g. `${f.title} [${f.kind}]`) — NEVER `evidence` or `domain`.

### Canonical `Scope`
**Source:** `src/hub/scope.ts:13-16`
```ts
export type Scope =
  | { mode: "general" }
  | { mode: "decision"; optionA: string; optionB: string }
  | { mode: "filtered"; domain?: string; dueWithinDays?: number; tag?: string };
```
`parseScope(raw: unknown): Scope` (`scope.ts:39-43`) validates and **falls back to
`{mode:"general"}` on any failure — never throws**, and Zod **strips unknown keys**.

**Command → Scope mapping (corrected — see Pitfall #1):**
| Command | Scope | rankFindings path |
|---|---|---|
| `/priority` | `{ mode: "general" }` | LLM relevance + lens passes |
| `/today` | `{ mode: "filtered", dueWithinDays: 1 }` | **pure JS** fast-path, ZERO LLM (`judge.ts:181-187`) |
| `/decide X vs Y` | `{ mode: "decision", optionA: X.trim(), optionB: Y.trim() }` | decision LLM relevance + lenses |

---

## 5. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `rankFindings` | `src/hub/judge.ts:174` | `(findings: Finding[], scope: Scope, llm: LLMClient, now: Date) => Promise<Finding[]>` | Two-pass hub ranking; returns final order (adapter must NOT re-rank). |
| `collectFindings` | `src/hub/collector.ts:16` | `(repoPaths: string[], scope?: string) => Finding[]` | Pool sibling findings read-only, dedup by id. Pure. |
| `parseScope` | `src/hub/scope.ts:39` | `(raw: unknown) => Scope` | Validate/normalize a Scope; never throws. |
| `resolveSiblingRepos` | `src/hub/repo-resolver.ts` | `(projectRoot: string, configured?: string[]) => Promise<string[]>` | Resolve kb-* sibling repo roots. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `const "hub"` | FactStore scope the hub stores findings under. |
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Build an LLM client from config (used only by `defaultPrioritize`). |
| `resolveRoleProviders` | `src/config/role-providers.ts` | `(config) => { chat, … }` | Pick the provider per role. |
| `loadConfig` | `src/config/loader.ts` | `(projectRoot) => Promise<Config>` | Load bober config. |
| `findProjectRoot` | `src/utils/fs.js` | `() => Promise<string | undefined>` | Locate project root (used by defaultCapture too). |
| `sendSafe` | `src/telegram/outbound.ts:27` | `(transport: TelegramTransport, chatId: number, content: string) => Promise<void>` | SOLE outbound funnel — all replies go through it. |
| `classify` | `src/telegram/router.ts:29` | `(message: string) => RoutedMessage` | Slash-command vs text classifier (already wired in dispatch). |
| `Finding` / `FindingSchema` | `src/hub/finding.ts:10,27` | Zod schema + type | Canonical finding shape — import, never redefine. |
| `Scope` / `parseScope` | `src/hub/scope.ts:13,39` | type + parser | Canonical query scope. |

Utilities reviewed: `src/hub/`, `src/telegram/`, `src/cli/commands/`, `src/providers/`, `src/config/`,
`src/utils/` — the above are the relevant ones. No new scope/finding/render util should be created.

---

## 6. Testing Patterns

**Runner:** vitest (`package.json:16`, `"test": "vitest"`). **Assertion:** `expect`. **Mocks:** plain
injected fakes (NO `vi.mock`). **File naming:** co-located `*.test.ts`. **Location:** next to source.

### Injected-fake template (mirror `capture.test.ts:5-24`)
**Source:** `src/telegram/handlers/capture.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { handlePrioritize } from "./prioritize.js";
import type { HubQuery } from "./prioritize.js";
import type { Finding } from "../../hub/finding.js";

// minimal valid Finding fixtures (schema requires id/domain/title/kind/urgency/severity/evidence/surfacedAt/tags/status)
const fx = (id: string, title: string): Finding => ({
  id, domain: "coding", title, kind: "action",
  urgency: 3, severity: 3, evidence: [], surfacedAt: "2026-06-30T00:00:00.000Z",
  tags: [], status: "open",
});

describe("handlePrioritize (sc-3-3, sc-3-4)", () => {
  it("renders findings as a numbered list in the hub's returned order (no re-rank)", async () => {
    const captured: unknown[] = [];
    const fakeHub: HubQuery = async (scope) => { captured.push(scope); return [fx("a","Alpha"), fx("b","Bravo"), fx("c","Charlie")]; };
    const reply = await handlePrioritize("priority", "", fakeHub);
    expect(reply).toBe("1. Alpha\n2. Bravo\n3. Charlie");          // order preserved verbatim
    expect(captured).toEqual([{ mode: "general" }]);               // scope passed through
  });

  it("/decide builds a decision scope with exactly the two trimmed options (sc-3-2)", async () => {
    let seen: unknown;
    const fakeHub: HubQuery = async (scope) => { seen = scope; return []; };
    await handlePrioritize("decide", "Buy a car vs Lease a car", fakeHub);
    expect(seen).toEqual({ mode: "decision", optionA: "Buy a car", optionB: "Lease a car" });
  });

  it("reply contains only titles (sc-3-4)", async () => {
    const fakeHub: HubQuery = async () => [fx("a","Renew passport")];
    const reply = await handlePrioritize("priority", "", fakeHub);
    expect(reply).toContain("Renew passport");
    expect(reply).not.toContain("evidence");   // no raw domain payload
  });
});
```
Parser test (sc-3-2) — if `parseScopeFromCommand` lives in router.ts, test it in `router.test.ts`
(mirror router.test.ts:9-17): assert `/today` → `{mode:"filtered",dueWithinDays:1}`, `/priority`
→ `{mode:"general"}`, `/decide A vs B` → `{mode:"decision",optionA:"A",optionB:"B"}`.

No E2E framework configured for this module (no `playwright.config.ts` under src/telegram).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/cli/commands/telegram.ts:5,50` | `startPollLoop` from `bot.ts` | medium | If you add a 4th param `prioritize=defaultPrioritize`, keep the existing `startPollLoop(transport, ac.signal)` call valid (default must keep it 2-arg-callable). |
| `src/telegram/bot.ts` (self) | `classify`, `sendSafe`, new `handlePrioritize` | medium | New imports compile; `/start` + Unknown-command fallback + text→capture unchanged. |
| `src/telegram/router.ts` consumers | only `bot.ts:11` | low | Adding an exported `parseScopeFromCommand` is additive — `classify` signature unchanged. |
| `src/hub/*` (judge/collector/scope/finding) | — | low | READ-ONLY consumers — do NOT modify any hub file. |

### Existing Tests That Must Still Pass
- `src/telegram/router.test.ts` — covers `classify()`; must still pass (don't change `classify`).
- `src/telegram/handlers/capture.test.ts` — capture handler; ensure dispatch text→capture path intact.
- `src/telegram/outbound.test.ts` — `sendSafe` funnel; ensure all replies still route through it.
- `src/telegram/whitelist.test.ts` — gate unchanged.
- `src/hub/scope.test.ts`, `src/hub/judge.test.ts`, `src/cli/commands/hub.test.ts` — hub surfaces you
  import; verify untouched (you only consume them).

### Features That Could Be Affected
- **Sprint 2 capture** — shares the `bot.ts` dispatch block; verify plain text still captures and
  `/start` still returns help (the new command arms must not shadow these).
- **`agent-bober hub` CLI** (`hub.ts`) — shares `rankFindings`/`collectFindings`/`Scope`; if you use
  execa it invokes this command — do not alter hub.ts behavior.

### Recommended Regression Checks
1. `npm run build` — zero tsc errors (sc-3-1).
2. `npx vitest run src/telegram` — router + capture + outbound + whitelist + new prioritize tests green.
3. `npx vitest run src/hub src/cli/commands/hub.test.ts` — hub surfaces unaffected.
4. Grep-confirm no `transport.sendMessage(` outside `outbound.ts` and no disk write in `prioritize.ts`.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/telegram/router.ts`** — add pure `parseScopeFromCommand(name, args): Scope | null`
   (`import type { Scope } from "../hub/scope.js"`). Map today→`{mode:"filtered",dueWithinDays:1}`,
   priority→`{mode:"general"}`, decide→split args on `/\s+vs\s+/i`+trim→`{mode:"decision",optionA,optionB}`
   (return `null` if name not in {today,priority,decide} or decide ≠2 options).
   - Verify: pure (no imports beyond the `Scope` type); `npm run build` still compiles.
2. **`src/telegram/handlers/prioritize.ts`** — `HubQuery` type, `handlePrioritize` (pure render,
   order-preserving `${i+1}. ${f.title}`), `defaultPrioritize` (§3a in-process import of `rankFindings`).
   - Verify: handler takes the injected `HubQuery`; no `transport`, no disk write, no `any`.
3. **`src/telegram/handlers/prioritize.test.ts`** — injected-fake tests (§6): order preserved,
   decision options trimmed-exactly-two, titles-only, scope passed through.
   - Verify: `npx vitest run src/telegram/handlers/prioritize.test.ts` green.
4. **`src/telegram/bot.ts`** — add `prioritize: PrioritizeFn = defaultPrioritize` to `startPollLoop`;
   route `today|priority|decide` to `handlePrioritize` then `sendSafe`; keep `/start`+Unknown+capture.
   - Verify: `src/cli/commands/telegram.ts:50` 2-arg call still type-checks; build green.
5. **Run full verification** — `npm run build` && `npx vitest run src/telegram src/hub`.

---

## 9. Pitfalls & Warnings

- **`horizon` is NOT a field on `Scope`.** generatorNotes literally write `{mode:'general', horizon:'today'}`
  but `Scope` (`scope.ts:13-16`) has no `horizon` — an object literal with it FAILS tsc excess-property
  checks (sc-3-1), and if routed through `parseScope(unknown)` Zod silently STRIPS it, making `/today`
  identical to `/priority` (fails sc-3-2's "time-horizon scope"). Use `{mode:"filtered", dueWithinDays:1}`
  for `/today` — the only canonical time-horizon mechanism (`scope.ts:16`, `applyFilter` scope.ts:72-76).
- **No `Finding.summary`.** Render `title` only (grep-confirmed absent). Never reach into `evidence`
  or `domain` (nonGoal #3). One-line suffix, if any, may use `kind` only.
- **Do NOT re-rank.** Reply order = `query(scope)` return order, verbatim (`ranked.map((f,i)=>…)`).
  The hub's `rankFindings` already produced the final order (`judge.ts:228-229`); re-sorting fails sc-3-3.
- **Ephemeral scope — no persistence.** The scope is derived from command text each call; `prioritize.ts`
  must contain ZERO disk writes (no FactStore open-for-write, no writeFile). `defaultCapture` opened a
  store to WRITE; `defaultPrioritize` only READS (`collectFindings` is `{readonly:true}`). (nonGoal #2.)
- **All replies via `sendSafe`.** Never call `transport.sendMessage` from the handler or the new dispatch
  arm — the handler returns a string; `bot.ts` passes it to `sendSafe` (outbound.ts:27, bot.ts:96-97).
- **No LLM reasoning in the adapter.** Do not summarize/score/filter findings yourself — delegate entirely
  to `rankFindings` (or the hub CLI). The adapter only parses the scope and renders titles. (nonGoal #5.)
- **ESM/typing:** every relative import ends in `.js`; use `import type` for `Scope`/`Finding`/`HubQuery`;
  no `any`. `rankFindings` takes a `Finding[]` pool (NOT a store) + an `LLMClient` + `Date` — build the
  pool with `collectFindings`, the client with `createClient` (only inside `defaultPrioritize`).
- **`startPollLoop` back-compat:** add the new `prioritize` param with a default so
  `telegram.ts:50` (`startPollLoop(transport, ac.signal)`) keeps compiling.

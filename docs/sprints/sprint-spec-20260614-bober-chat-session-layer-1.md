# Chat REPL that answers — walking skeleton, chat role, resumable session

**Contract:** sprint-spec-20260614-bober-chat-session-layer-1  ·  **Spec:** spec-20260614-bober-chat-session-layer  ·  **Completed:** 2026-06-14

## What this sprint added

The thin `bober chat` REPL skeleton: an interactive turn loop that answers
questions using the on-disk run roster and the `.bober/memory/` lesson distill as
context. Each turn is classified by one loose-JSON LLM call (parse-fail falls back
to a plain answer), answered by a second LLM call, and persisted to a resumable
per-session JSONL. A dedicated `chat` **prompt** role was added to `BoberConfig`
(Zod schema + greenfield/brownfield defaults) and resolved through the existing
`resolveRoleProviders` + `createClient` path, so the session runs identically on
Anthropic and DeepSeek. Deterministic slash-commands (`/runs`, `/help`, `/exit`)
are handled without any LLM call. Spawn and steer actions are intentionally
stubbed — the classifier may emit them, but the session replies that those arrive
in a later sprint.

## Public surface

- `bober chat [team]` CLI command (`src/cli/commands/chat.ts:20`) — starts an interactive chat session; the optional `[team]` argument is accepted but ignored in Phase 1. Registered in `src/cli/index.ts`.
- `chat` config role — `ChatSectionSchema` (`src/config/schema.ts:351`) with `model` (default `opus`), optional `provider`, `endpoint`, `providerConfig`; exposed as the optional `chat` key on `BoberConfig`. Defaults to `{ model: "opus", provider: "anthropic" }` for both greenfield and brownfield (`src/config/defaults.ts`). Added to the `RoleName` union and the `PROMPT_ROLES` list (`src/config/role-providers.ts`), so `claude-code` is always an allowed provider for it.
- `ChatSession` (`src/chat/chat-session.ts:54`) — main turn loop. `start()` runs the stdin REPL; `handleTurn(input): Promise<string | null>` processes one turn (returns `null` on `/exit`) and is the test entry point.
- `TurnClassifier.classify(input)` (`src/chat/turn-classifier.ts:107`) — one `jsonObjectMode:true` LLM call returning a `ClassifierAction`; any LLM or parse failure returns `{ action: "answer" }`.
- `ClassifierAction` type (`src/chat/turn-classifier.ts:11`) — `answer | spawn{task} | steer{op:"inspect"} | steer{op:"stop",runId}`. Only `answer` is handled this sprint.
- `Answerer.answer(input, rosterSummary, memoryDistill, recentHistory)` (`src/chat/answerer.ts:28`) — composes roster + memory + recent history into one (non-JSON) LLM call.
- `RosterReader` (`src/chat/roster-reader.ts:11`) — `read()` delegates to `readRunStatesFromDisk` (read-only; never the reconciling `RunManager.load`); `summarize(states)` renders the compact roster text used by `/runs` and as prompt context.
- `ConversationStore` (`src/chat/conversation-store.ts:32`) — append-only JSONL at `.bober/chat/<sessionId>.jsonl`. `append(record)` and `loadRecent(limit)` (newest-last, skips malformed lines, empty on missing file).
- `dispatch(input, roster)` (`src/chat/slash-commands.ts:33`) — deterministic slash-command router; returns `{ handled: false }` for non-slash input and never touches the LLM.

## How to use / how it fits

```bash
bober chat            # start an interactive session
> what runs are active?    # answered via roster + memory context
> /runs                    # deterministic roster summary, no LLM call
> /help                    # list slash commands
> /exit                    # end the session
```

The CLI loads `bober.config.json`, resolves the `chat` provider, and constructs a
`ChatSession` with `sessionId: "default"`. Conversation is written to
`.bober/chat/default.jsonl`; relaunching `bober chat` resumes from that file
(the answerer feeds the recent turns back as message history). To run chat on
DeepSeek instead of Anthropic, override the role in config:

```jsonc
{ "chat": { "provider": "deepseek", "model": "deepseek-chat" } }
```

## Notes for maintainers

- This is a **walking skeleton**. By design the classifier's `spawn` and `steer`
  outputs are acknowledged but not executed — spawn is Sprint 2, completion
  weaving is Sprint 3, steer-stop is Sprint 4. (Sprint 2 has since wired the
  `spawn` action to a real detached run via `RunSpawner` — see
  [sprint-spec-20260614-bober-chat-session-layer-2.md](./sprint-spec-20260614-bober-chat-session-layer-2.md).)
- No provider SDK types leak into `src/chat` — all LLM access goes through
  `src/providers` (verified: no `@anthropic-ai/sdk` or `openai` imports under
  `src/chat`).
- `RosterReader` must never call `RunManager.load()` (it reconciles
  `running → failed`); chat reads disk state read-only via
  `readRunStatesFromDisk`.
- The session id is the literal `"default"` per project in Phase 1; multi-session
  handshakes are deferred.
- This sprint also touched two existing tests to keep them valid against the new
  prompt role: `src/config/role-providers.test.ts` (logger count 6→7) and
  `src/config/loader.test.ts` (all-`claude-code` throw scenarios).

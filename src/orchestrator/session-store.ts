// ── session-store.ts ────────────────────────────────────────────────────
//
// Persists the own agentic loop's provider-agnostic transcript (`Message[]`)
// to `.bober/sessions/<sessionId>.json`, opt-in via `AgenticLoopParams.session`
// (agent-loop-capability-port sprint 6). Mirrors `src/research/job-store.ts`:
// `ensureDir`, Zod `safeParse`-before-write, `JSON.parse`+`safeParse`-on-read
// returning `null` on missing OR malformed (never throws), async fs only.
//
// NOT the same layer as `src/chat/conversation-store.ts` (`.bober/chat/`,
// chat `/resume`) or do-bridge's `sessionId` (a spawned-run id,
// `do-<findingId>`) — this store is model-context transcript resume/fork for
// the own loop. Keep the names distinct (see this sprint's contract nonGoals).

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { ensureDir } from "../state/helpers.js";
import type { Message } from "../providers/types.js";

// ── Zod mirror of the Message union (providers/types.ts:135-139) ──────
//
// There is no existing Zod schema for `Message` in the codebase — authored
// here. IMPORTANT: `z.union` tries variants in order and returns the FIRST
// match. `AssistantMessage {role:"assistant",content,toolCalls}` and
// `TextMessage {role:"assistant",content}` overlap on `{role,content}` (zod
// objects are non-strict by default, so an extra key like `toolCalls` is
// simply allowed/stripped by the less-specific schema). `AssistantMessageSchema`
// MUST come before `TextMessageSchema` in the union below, or an assistant
// message WITH `toolCalls` silently loses them on round-trip.

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const ToolResultSchema = z.object({
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});

const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema),
});

const ToolResultMessageSchema = z.object({
  role: z.literal("user"),
  toolResults: z.array(ToolResultSchema),
});

const SystemUpdateMessageSchema = z.object({
  role: z.literal("user"),
  systemUpdate: z.string(),
  cacheTtl: z.enum(["5m", "1h"]).optional(),
});

const TextMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

/**
 * Mirrors the `Message` union (providers/types.ts:135-139). Variant order
 * matters — see the ordering note above. Keep this schema in sync if the
 * `Message` union ever changes shape.
 */
export const MessageSchema: z.ZodType<Message> = z.union([
  AssistantMessageSchema,
  ToolResultMessageSchema,
  SystemUpdateMessageSchema,
  TextMessageSchema,
]);

// ── SessionRecord ───────────────────────────────────────────────────────

export const SessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turnsUsed: z.number().int().nonnegative(),
  messages: z.array(MessageSchema),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Input to `SessionStore.save` — `createdAt`/`updatedAt` are stamped
 * internally from the store's injected clock, so callers never read the
 * clock themselves (no argless `new Date()` in core).
 */
export type SessionSaveInput = Omit<SessionRecord, "createdAt" | "updatedAt">;

// ── Path helpers ──────────────────────────────────────────────────────

const SESSIONS_DIR = ".bober/sessions";

function sessionsDir(projectRoot: string): string {
  return join(projectRoot, SESSIONS_DIR);
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── Deterministic fork id ───────────────────────────────────────────────

/**
 * Derive a deterministic fork id from a source `sessionId` + an injected
 * timestamp. Mirrors `job-store.ts`'s `jobId()` content-hash pattern — no
 * argless `randomUUID()`/`Date.now()`. Used by `forkSession()`
 * (agentic-loop.ts) when the caller omits an explicit `newId`.
 */
export function sessionForkId(sessionId: string, now: string): string {
  return createHash("sha256")
    .update(`${sessionId}|fork|${now}`)
    .digest("hex")
    .slice(0, 16);
}

// ── SessionStore ──────────────────────────────────────────────────────

export interface SessionStoreOptions {
  /** Absolute project root; sessions are written under `<projectRoot>/.bober/sessions/`. */
  projectRoot: string;
  /** Clock injection. Defaults to `() => new Date().toISOString()`. No argless `new Date()` in core. */
  now?: () => string;
}

/**
 * Persists agentic-loop transcripts to `.bober/sessions/<sessionId>.json`.
 * Mirrors `src/research/job-store.ts`: validates with Zod before every
 * write; reads return `null` on both missing AND malformed JSON (never
 * throws) — this is what lets `resumeSession` fail soft (sc-6-5).
 */
export class SessionStore {
  private readonly projectRoot: string;
  private readonly clock: () => string;

  constructor(opts: SessionStoreOptions) {
    this.projectRoot = opts.projectRoot;
    this.clock = opts.now ?? (() => new Date().toISOString());
  }

  /** Current time from the injected clock — exposed for deterministic fork-id derivation. */
  now(): string {
    return this.clock();
  }

  /** Absolute path to the session file for `sessionId`. */
  path(sessionId: string): string {
    return join(sessionsDir(this.projectRoot), `${sanitizeId(sessionId)}.json`);
  }

  /**
   * Persist a session record. Validates with `SessionRecordSchema` before
   * writing so an invalid record never reaches disk (mirrors job-store.ts).
   * `createdAt` is preserved from the existing file on disk when one exists
   * (first save for a given `sessionId` stamps it fresh); `updatedAt` is
   * always stamped fresh from the injected clock.
   *
   * bober: re-reads the existing file on every save to preserve `createdAt`
   * — an O(1) extra read per turn, fine at this scale. If this ever needs to
   * avoid the extra read, cache `createdAt` in-memory in the caller (the
   * loop already holds a `session` handle across turns) and pass it through
   * explicitly instead.
   */
  async save(record: SessionSaveInput): Promise<void> {
    await ensureDir(sessionsDir(this.projectRoot));

    const existing = await this.load(record.sessionId);
    const now = this.clock();
    const full: SessionRecord = {
      ...record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const validation = SessionRecordSchema.safeParse(full);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid session record:\n${issues}`);
    }

    await writeFile(
      this.path(record.sessionId),
      JSON.stringify(validation.data, null, 2) + "\n",
      "utf-8",
    );
  }

  /**
   * Load a session record by id. Returns `null` if not found or malformed —
   * NEVER throws. This null-on-corrupt result is what `resumeSession` maps
   * to its typed `{ error }` result (sc-6-5); a corrupt file is never
   * silently overwritten with an empty session.
   */
  async load(sessionId: string): Promise<SessionRecord | null> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(this.path(sessionId), "utf-8"),
      );
      const result = SessionRecordSchema.safeParse(raw);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Copy the transcript at `sessionId` into a new session file under
   * `newId`. Writes ONLY the new file — the source is only ever read, never
   * rewritten, so continuing the fork leaves the original byte-identical
   * (sc-6-3). Throws if the source session does not exist or is corrupt
   * (nothing to fork).
   */
  async fork(sessionId: string, newId: string): Promise<string> {
    const source = await this.load(sessionId);
    if (!source) {
      throw new Error(
        `Cannot fork session '${sessionId}': not found or corrupt.`,
      );
    }

    await this.save({
      sessionId: newId,
      model: source.model,
      turnsUsed: source.turnsUsed,
      messages: source.messages,
    });

    return newId;
  }
}

import type { Stack } from "../../config/schema.js";
import type { SecurityStackId } from "./signature.js";

/**
 * Retargets the old 3-entry `STACK_SKILL_MAP` (stack-knowledge.ts) to the 8
 * `SecurityStackId`s and their `bober.security-<stack>` skill files
 * (arch-20260712-security-audit-agent-team-architecture.md). Every
 * `SecurityStackId` — including "generic" — has a real skill name; there is
 * no `null` skill case anymore (the old resolver's `{skillName: null}`
 * degrade path is replaced by the generic floor, sc-5-1).
 */

// ── Stack -> skill name ─────────────────────────────────────────────

function skillNameForStackId(stackId: SecurityStackId): string {
  return `bober.security-${stackId}`;
}

const SECURITY_STACK_IDS: readonly SecurityStackId[] = [
  "solidity",
  "anchor",
  "react",
  "node",
  "payments",
  "igaming",
  "dex-backend",
  "generic",
];

/** stackId -> skillName, 8 entries. The index iterates these to load each skill file. */
export const STACK_SKILL_MAP_ENTRIES: ReadonlyArray<{ stackId: SecurityStackId; skillName: string }> =
  SECURITY_STACK_IDS.map((stackId) => ({ stackId, skillName: skillNameForStackId(stackId) }));

// ── Keyword -> SecurityStackId (blockchain/language before frontend/backend) ─

interface StackKeyword {
  pattern: string;
  stackId: Exclude<SecurityStackId, "generic">;
}

/**
 * Substring match, lowercased. Order within this table does not encode
 * precedence between stacks (a candidate matches at most one pattern in
 * practice) — the blockchain/language-before-frontend/backend precedence
 * comes from the candidate ORDER built in `candidatesFor`, ported from
 * `detectStack` (stack-knowledge.ts:86-98).
 */
const STACK_KEYWORDS: readonly StackKeyword[] = [
  { pattern: "solidity", stackId: "solidity" },
  { pattern: "evm", stackId: "solidity" },
  { pattern: "foundry", stackId: "solidity" },
  { pattern: "hardhat", stackId: "solidity" },
  { pattern: "anchor", stackId: "anchor" },
  { pattern: "solana", stackId: "anchor" },
  { pattern: "react", stackId: "react" },
  { pattern: "next", stackId: "react" },
  { pattern: "node", stackId: "node" },
  { pattern: "express", stackId: "node" },
  { pattern: "typescript", stackId: "node" },
  { pattern: "nest", stackId: "node" },
  { pattern: "fastify", stackId: "node" },
  { pattern: "payment", stackId: "payments" },
  { pattern: "stripe", stackId: "payments" },
  { pattern: "pci", stackId: "payments" },
  { pattern: "igaming", stackId: "igaming" },
  { pattern: "casino", stackId: "igaming" },
  { pattern: "betting", stackId: "igaming" },
  { pattern: "wager", stackId: "igaming" },
  { pattern: "dex", stackId: "dex-backend" },
  { pattern: "amm", stackId: "dex-backend" },
  { pattern: "orderbook", stackId: "dex-backend" },
];

/**
 * Precedence ported verbatim from `detectStack` (stack-knowledge.ts:86-98):
 * blockchain and language fields are checked before frontend/backend/testing/
 * database/other, since blockchain-specific values are more determinative of
 * the security checklist to use than a generic frontend/backend framework.
 */
function candidatesFor(stack: Stack | string | undefined): string[] {
  const candidates: string[] = [];

  if (typeof stack === "string") {
    if (stack.trim().length > 0) candidates.push(stack);
  } else if (stack && typeof stack === "object") {
    const ordered: Array<string | undefined> = [
      stack.blockchain,
      stack.language,
      stack.frontend,
      stack.backend,
      stack.testing,
      stack.database,
      ...(stack.other ?? []),
    ];
    for (const value of ordered) {
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.push(value);
      }
    }
  }

  return candidates;
}

export interface StackResolution {
  /** Always a real SecurityStackId — "generic" for unknown/absent/null (never null, never a throw). */
  stackId: SecurityStackId;
  /** The matched candidate string verbatim (e.g. "solidity"), or "unknown" when nothing matched. */
  stackLabel: string;
  /** Always "bober.security-<stackId>" — a real skill name, never null. */
  skillName: string;
}

/**
 * Resolves a declared/detected stack to one of the 8 `SecurityStackId`s and
 * its `bober.security-<stack>` skill name. Unknown/absent/null stacks
 * degrade to `{stackId: "generic", ...}` — never null, never a throw
 * (sc-5-1).
 */
export const SecurityStackRegistry = {
  resolve(stack: Stack | string | undefined): StackResolution {
    const candidates = candidatesFor(stack);

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      const match = STACK_KEYWORDS.find((k) => lower.includes(k.pattern));
      if (match) {
        return {
          stackId: match.stackId,
          stackLabel: candidate,
          skillName: skillNameForStackId(match.stackId),
        };
      }
    }

    return {
      stackId: "generic",
      stackLabel: candidates[0] ?? "unknown",
      skillName: skillNameForStackId("generic"),
    };
  },
};

import type { Stack } from "../../config/schema.js";
import type { VulnClass } from "../security-audit-types.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";
import { resolveLensFocus } from "../eval-lenses.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";
import { SecurityStackRegistry } from "./registry.js";
import { selectSignatures } from "./selector.js";
import type { SecurityKnowledgeIndex } from "./index.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Replaces the old head-excerpt `StackSecurityContext` (stack-knowledge.ts:20-29,
 * the G3 defect) with a retrieval-grounded one: `stackId` and `signatures`
 * are new, `promptFragment` now renders retrieved signatures rather than a
 * frontmatter/head-excerpt of the skill file.
 */
export interface StackSecurityContext {
  stackId: SecurityStackId;
  /** The matched candidate string (e.g. "solidity"), or "unknown". */
  stackLabel: string;
  /** Always "bober.security-<stackId>" — never null. */
  skillName: string;
  /** The canonical vulnerability-class taxonomy — stable across stacks. */
  taxonomy: VulnClass[];
  /** The retrieved signatures folded into promptFragment, in rendered order. */
  signatures: SecuritySignature[];
  /** Text to inject verbatim into the auditor's prompt. Never empty. */
  promptFragment: string;
}

// ── Prompt rendering ───────────────────────────────────────────────

function renderSignature(signature: SecuritySignature): string {
  const cweSuffix = signature.cwe ? ` (${signature.cwe})` : "";
  return [
    `### ${signature.signatureId} — ${signature.title}${cweSuffix}`,
    `Invariant: ${signature.invariant}`,
    "",
    "Unsafe:",
    "```ts",
    signature.unsafeExample,
    "```",
    "",
    "Safe:",
    "```ts",
    signature.safeExample,
    "```",
  ].join("\n");
}

/**
 * Renders the retrieved signatures into a compact prompt fragment. NEVER
 * empty: falls back to `resolveLensFocus("security")` when the selected set
 * is somehow empty (e.g. a wholly missing skills directory), which the
 * generic floor normally prevents (closes G3).
 */
function renderPromptFragment(signatures: SecuritySignature[], threatModelText: string | undefined): string {
  const body =
    signatures.length > 0 ? signatures.map(renderSignature).join("\n\n") : resolveLensFocus("security");

  return threatModelText ? `${body}\n\n${threatModelText}` : body;
}

// ── Resolver ───────────────────────────────────────────────────────

export interface ResolveStackSecurityContextInput {
  /** `config.project.stack`, or a plain string (test ergonomics). */
  stack: Stack | string | undefined;
  /** Files in scope for the audit — the diff provider lands sprint 6, so this is contract.estimatedFiles for now. */
  changedPaths: string[];
  /** Keywords extracted from a real diff — [] until sprint 6 supplies one. */
  diffKeywords?: string[];
  /** A loaded (load() already awaited) SecurityKnowledgeIndex. */
  index: SecurityKnowledgeIndex;
  /** Max ranked (non-floor) signatures to select. Defaults to 8. */
  topK?: number;
  /** Optional threat-model text appended verbatim after the rendered signatures. */
  threatModelText?: string;
}

/**
 * Resolves the security prompt context for a declared/detected stack via
 * retrieval over the parsed skill signatures — replacing the head-excerpt
 * resolver formerly at stack-knowledge.ts:198-225 (G3).
 *
 * Never throws: an unrecognised stack resolves to the generic floor; a
 * wholly missing skills directory resolves to the `resolveLensFocus`
 * fallback text. `promptFragment` is never empty.
 */
export async function resolveStackSecurityContext(
  input: ResolveStackSecurityContextInput,
): Promise<StackSecurityContext> {
  const { stackId, stackLabel, skillName } = SecurityStackRegistry.resolve(input.stack);

  const stackSignatures = input.index.forStack(stackId);
  const genericFloor = stackId === "generic" ? stackSignatures : input.index.forStack("generic");

  const signatures = selectSignatures({
    stackId,
    changedPaths: input.changedPaths,
    diffKeywords: input.diffKeywords ?? [],
    topK: input.topK ?? 8,
    stackSignatures,
    genericFloor,
  });

  return {
    stackId,
    stackLabel,
    skillName,
    taxonomy: [...ALL_VULN_CLASSES],
    signatures,
    promptFragment: renderPromptFragment(signatures, input.threatModelText),
  };
}

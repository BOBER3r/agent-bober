import { resolve, relative, isAbsolute } from "node:path";

/**
 * Validate a path lives inside projectRoot.
 *
 * Returns `{ok: true, abs}` if `inputPath` resolves to a location
 * within `projectRoot`. Returns `{ok: false}` for:
 *   - null/undefined inputs (buggy upstream responses)
 *   - paths that resolve outside the project root (e.g. "../../etc/passwd")
 *
 * Mirrors `sandboxPath` from src/orchestrator/tools/handlers.ts:31-45
 * but returns a result envelope instead of throwing — graph code drops
 * out-of-sandbox NodeRefs silently rather than crashing the agent loop.
 */
export function sandboxNodePath(
  projectRoot: string,
  inputPath: string | null | undefined,
): { ok: true; abs: string } | { ok: false } {
  if (!inputPath || typeof inputPath !== "string") return { ok: false };

  const abs = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(projectRoot, inputPath);

  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false };

  return { ok: true, abs };
}

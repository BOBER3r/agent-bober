import type { SecuritySignature, SecurityStackId } from "./signature.js";

export interface SelectInput {
  stackId: SecurityStackId;
  changedPaths: string[];
  diffKeywords: string[];
  topK: number;
  /** Typically index.forStack(stackId). */
  stackSignatures: SecuritySignature[];
  /** Typically index.forStack("generic") — ALWAYS included in the result. */
  genericFloor: SecuritySignature[];
}

/** score = stack membership + keyword overlap (signature.keywords vs diffKeywords) + path hints. */
function scoreSignature(signature: SecuritySignature, input: SelectInput): number {
  let score = 0;

  if (signature.stackId === input.stackId) score += 3;

  const diffKeywordSet = new Set(input.diffKeywords.map((k) => k.toLowerCase()));
  for (const keyword of signature.keywords) {
    if (diffKeywordSet.has(keyword.toLowerCase())) score += 2;
  }

  const basenames = input.changedPaths
    .map((path) => path.split("/").pop()?.toLowerCase() ?? "")
    .filter((base) => base.length > 0);
  const idLower = signature.signatureId.toLowerCase();
  for (const base of basenames) {
    const hint =
      idLower.includes(base) || signature.keywords.some((keyword) => base.includes(keyword.toLowerCase()));
    if (hint) score += 1;
  }

  return score;
}

/**
 * Pure and total: ranks `stackSignatures` by score, caps at `topK`, then
 * ALWAYS concatenates `genericFloor` (deduped by `signatureId`) so the floor
 * is present even when it did not rank into the top-K on its own merit.
 */
export function selectSignatures(input: SelectInput): SecuritySignature[] {
  const stackSignatures = Array.isArray(input.stackSignatures) ? input.stackSignatures : [];
  const genericFloor = Array.isArray(input.genericFloor) ? input.genericFloor : [];
  const topK = Number.isFinite(input.topK) ? Math.max(0, Math.trunc(input.topK)) : 0;

  const ranked = stackSignatures
    .map((signature) => ({ signature, score: scoreSignature(signature, input) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.signature);

  const selected = [...ranked];
  const seen = new Set(selected.map((s) => s.signatureId));
  for (const floorSignature of genericFloor) {
    if (!seen.has(floorSignature.signatureId)) {
      seen.add(floorSignature.signatureId);
      selected.push(floorSignature);
    }
  }

  return selected;
}

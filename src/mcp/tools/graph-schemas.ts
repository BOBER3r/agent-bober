import { z } from "zod";

// ── graph_search ─────────────────────────────────────────────────────
export const GraphSearchInputSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
export type GraphSearchInput = z.infer<typeof GraphSearchInputSchema>;

// ── graph_query ──────────────────────────────────────────────────────
export const QueryPatternSchema = z.enum([
  "callers_of",
  "callees_of",
  "imports_of",
  "tests_for",
]);
export const GraphQueryInputSchema = z.object({
  pattern: QueryPatternSchema,
  target: z.string().min(1, "target must be a non-empty string"),
});
export type GraphQueryInput = z.infer<typeof GraphQueryInputSchema>;

// ── graph_impact ─────────────────────────────────────────────────────
export const GraphImpactInputSchema = z.object({
  target: z.string().min(1, "target must be a non-empty string"),
});
export type GraphImpactInput = z.infer<typeof GraphImpactInputSchema>;

// ── graph_review_context ─────────────────────────────────────────────
export const NodeRefSchema = z.object({
  id: z.string(),
  kind: z.enum(["function", "class", "module", "symbol"]),
  file: z.string(),
  line: z.number().int(),
  symbol: z.string(),
});
export const GraphReviewContextInputSchema = z.object({
  nodes: z.array(NodeRefSchema).min(1, "nodes must be a non-empty array"),
});
export type GraphReviewContextInput = z.infer<typeof GraphReviewContextInputSchema>;

// ── graph_overview ───────────────────────────────────────────────────
export const GraphOverviewInputSchema = z.object({});
export type GraphOverviewInput = z.infer<typeof GraphOverviewInputSchema>;

// ── graph_changes ────────────────────────────────────────────────────
export const GraphChangesInputSchema = z.object({
  since: z.string().optional(),
});
export type GraphChangesInput = z.infer<typeof GraphChangesInputSchema>;

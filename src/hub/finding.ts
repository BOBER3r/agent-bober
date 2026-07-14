import { z } from "zod";

// ── Schema ───────────────────────────────────────────────────────────

/**
 * Canonical Finding schema — the hub owns this definition.
 * All other modules that produce or consume Findings MUST import from here.
 * Do NOT redefine Finding anywhere else in the codebase.
 */
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),
  tags: z.array(z.string()),
  estDurationMin: z.number().int().optional(),
  calendarSafeTitle: z.string().optional(),
  status: z.enum(["open", "in-progress", "snoozed", "done", "dropped"]),
  promotesTo: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

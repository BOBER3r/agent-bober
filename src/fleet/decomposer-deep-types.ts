// bober: Leaf types module — INTENTIONALLY has no relative imports.
//
// It exists to break the `critic-deep` <-> `decomposer-deep` import cycle: critic-deep needs the
// `Outline` type but must NOT depend on decomposer-deep.ts (the cycle node). Hosting Outline here —
// a dependency-free leaf both modules can import — removes critic-deep's last edge to decomposer-deep
// (mirrors the ./decomposer-deep-constants.ts precedent that broke the init-time TDZ cycle,
// inc-20260620-cli-tdz-crash). decomposer-deep.ts re-exports these so its public surface is unchanged.

// ── Types ────────────────────────────────────────────────────────────

export type OutlineArea = { name: string; intent: string };
export type Outline = { areas: OutlineArea[] };

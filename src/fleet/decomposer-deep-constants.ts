// bober: Leaf constants module — INTENTIONALLY has no imports.
//
// It exists to break the `decomposer-deep` <-> `critic-deep` module-init circular-import
// temporal-dead-zone crash (incident inc-20260620-cli-tdz-crash). `critic-deep.ts` reads
// DEEP_MAX_TOTAL_CALLS + DEEP_EXPAND_MAX_RETRIES at module-evaluation time to derive
// DEEP_CRITIQUE_MAX_TOTAL_CALLS; when those bindings lived in `decomposer-deep.ts` (which
// imports `runCritiqueLoop` back from `critic-deep.ts`), entering the graph via
// `decomposer-deep` first left them in their TDZ → ReferenceError, killing the whole CLI.
// Sourcing them from this dependency-free leaf makes the init-time reads order-independent.
export const DEEP_PLAN_MAX_RETRIES = 1;
export const DEEP_EXPAND_MAX_RETRIES = 1;
// bober: fixed budget = (1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES); upgrade path: increase retries constants
export const DEEP_MAX_TOTAL_CALLS = 4;

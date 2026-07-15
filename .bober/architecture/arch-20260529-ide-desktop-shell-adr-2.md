# ADR-2: Typed in-app registry, not a runtime plugin system

**Decision:** Make extensibility a compile-time typed registry (`ConsoleRegistry.registerTab/registerCommand/registerPanel` + typed `SlotId` slots) inside a single monorepo, not a runtime plugin loader.

**Context:** The console must be VERY CUSTOMISABLE & EXPANDABLE with a fast add-a-feature loop in one language. `agent-bober-ui/app.jsx:67-78` hardcodes the 7 tabs in a switch — adding a tab means editing the shell.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Typed in-app registry | Full TS type-checking of every extension point; one build; Cmd-Click/refactor across tabs+commands; no sandbox/version-skew | Adding a feature requires a rebuild (not hot-loadable by third parties) |
| Runtime plugin system | Third parties ship plugins without rebuilding; dynamic load | Needs a stable serialised API, sandboxing, capability gating, version negotiation — large surface for a solo builder; loses end-to-end types |

**Rationale:** Checkpoint 1's PRIMARY constraint is a fast add-a-feature loop for a SOLO builder serving technical power users — there is no third-party-plugin distribution requirement, so the runtime plugin system's sandboxing/versioning cost is premature complexity that directly slows the solo loop the constraint optimises for.

**Consequences:** New tabs/commands/panels are added by one `register*` call against a typed contract; `command-palette.jsx`'s static `PALETTE_ITEMS` becomes `ConsoleRegistry.commands(ctx)`. The `self` tab edits source in the same repo and a rebuild applies it.

**Risk:** If third-party distribution becomes required, the registry must be re-fronted with a serialisable plugin boundary; the `*Def` types are designed to be JSON-describable to ease that, but a true sandbox would still be net-new.

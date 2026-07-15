# ADR-4: Monaco-based 3-way merge editor, not an embedded OpenVSCode iframe

**Decision:** Implement conflict resolution with a Monaco 3-pane (base/ours/theirs → merged) surface inside `DiffMergeSurface`, reusing the Monaco instance already used for inline diffs, rather than embedding an OpenVSCode-server iframe.

**Context:** The editor must view diffs, edit files, and see/resolve merge conflicts — explicitly NO LSP, debugger, or marketplace. `cockpit/package.json` already floors `monaco-editor@0.55` + `@monaco-editor/react@4.7`.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Monaco 3-way | One editor engine already in the dep floor; full control over conflict UI; no extra server process | Must build the 3-pane merge UI on top of Monaco models |
| OpenVSCode iframe | Built-in merge editor + file tree | Ships a whole VS Code server (LSP, debugger, marketplace) the constraint forbids; heavy second runtime; iframe↔host bridging for git writes |

**Rationale:** Checkpoint 1 explicitly excludes LSP/debugger/marketplace, which is precisely the bulk of what OpenVSCode would add; Monaco is already the diff engine, so the 3-way merge reuses one runtime and keeps the install lean for a desktop app. User confirmed this choice at Checkpoint 3.

**Consequences:** `DiffMergeSurface` reads `ConflictFile{ours,theirs,base}` from `GitService.conflicts` and writes the merged buffer back via `gitWriteFile` + `gitMarkResolved` (`git add`); the editor stays free of language servers.

**Risk:** Monaco has no turnkey merge widget, so the 3-pane conflict UX is hand-built; if it proves too costly, the documented last-resort fallback is a merge-only OpenVSCode iframe — but that re-imports the forbidden marketplace/LSP surface.

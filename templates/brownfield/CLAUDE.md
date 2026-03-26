# Brownfield Project Guide

## Working with Existing Code

This is a brownfield project. The codebase has existing patterns, conventions, and tests that must be respected.

### Before Making Changes

1. **Read first.** Before modifying any file, read the surrounding code to understand local conventions (naming, patterns, abstractions).
2. **Run existing tests.** Execute the full test suite before starting work. Record the baseline pass/fail state so you can detect regressions.
3. **Understand the dependency graph.** Check imports and exports to know what depends on the code you are changing.

### While Making Changes

- **Follow existing patterns.** If the codebase uses a particular abstraction (e.g., repository pattern, custom hooks, service layer), use the same abstraction. Do not introduce competing patterns.
- **Match the style.** Match indentation, naming conventions, comment style, and file organization of the surrounding code. Consistency matters more than personal preference.
- **Minimal surface area.** Change only what is necessary to deliver the feature. Avoid drive-by refactors unless they are part of the sprint contract.
- **Preserve public APIs.** Do not change function signatures, type exports, or module interfaces unless the sprint contract explicitly requires it. Other code depends on them.
- **Add tests for new behavior.** Every new code path needs a corresponding test. Use the same test framework and patterns already in the project.

### After Making Changes

1. **Run the full test suite.** All previously passing tests must still pass.
2. **Run the linter.** Zero new warnings or errors.
3. **Run type checking.** Zero new type errors.
4. **Review the diff.** The changeset should be focused and minimal. Remove accidental changes (whitespace, formatting, unrelated files).

## Commands

Commands are auto-detected from the existing project. Check `bober.config.json` for the resolved command map, or inspect `package.json` / `Makefile` / `pyproject.toml` for the project's native commands.

## Architecture

Refer to the project's own README, CLAUDE.md, or architecture docs for structural guidance. The bober planner will analyze the codebase during planning and encode relevant context into sprint contracts.

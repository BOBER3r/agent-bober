> Anti-pattern reference catalog. All four docs in this directory are verbatim ports from
> [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> See each file for its individual `Original:` path.

# Anti-Pattern Catalog

This catalog is the canonical reference cited by `agents/bober-evaluator.md` in the
`regressions` field of `EvalResult` when a detected regression matches a known anti-pattern.

## Index

| Anti-pattern | When to flag | File |
|--------------|--------------|------|
| Testing Mock Behavior | Test asserts on `*-mock` test IDs or mock-only elements | [testing-anti-patterns.md](./testing-anti-patterns.md) |
| Test-Only Methods in Production | Production class has methods called only from tests | [testing-anti-patterns.md](./testing-anti-patterns.md) |
| Mocking Without Understanding | Mock setup breaks behavior the test depends on | [testing-anti-patterns.md](./testing-anti-patterns.md) |
| Incomplete Mocks | Mock omits fields the production code consumes | [testing-anti-patterns.md](./testing-anti-patterns.md) |
| Tests as Afterthought | Implementation shipped without tests written first | [testing-anti-patterns.md](./testing-anti-patterns.md) |
| Arbitrary-Delay Waiting | Test uses `setTimeout`/`sleep` instead of waiting for a real condition | [condition-based-waiting.md](./condition-based-waiting.md) |
| Symptom-Fix Instead of Root-Cause | Bug patched where it surfaces instead of traced to its source | [root-cause-tracing.md](./root-cause-tracing.md) |
| Single-Layer Validation | Bug fixed at only one checkpoint; defense-in-depth missing | [defense-in-depth.md](./defense-in-depth.md) |

## Usage by evaluators

When `agents/bober-evaluator.md` finds a regression that matches one of the above rows,
it MUST cite the anti-pattern by name in the regression entry. See the "Anti-Pattern
Citations" subsection in the evaluator agent for the extended `Regression` shape.

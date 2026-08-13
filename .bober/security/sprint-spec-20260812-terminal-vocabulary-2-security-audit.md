# Security Audit — sprint-spec-20260812-terminal-vocabulary-2

Scope: `git show a5c8531` — four `.bober/contracts/*.json` status lines + 140 added lines in `src/contracts/sprint-contract.test.ts`.
Verdict: **PASS — clean.** 0 critical, 0 important, 0 minor.

The only executable code in the diff is test code (`sprint-contract.test.ts:334-456`). All three named risks were checked and are negative:

1. **Filesystem handling takes no untrusted input.** `dir` is either a compile-time constant derived from `import.meta.url` or an `mkdtemp` result; `readdir` returns basenames only, so `join(dir, file)` cannot escape `dir`. Temp dirs use `mkdtemp` (atomic, 0700, random suffix — no predictable-path/TOCTOU window) and are popped and `rm -rf`'d in an `afterEach` registered *before* any throwing await, so cleanup holds on failure as well as success.
2. **The test never writes into the repo corpus.** Every `writeFile`/`copyFile` destination and every `rm` target resolves under the `mkdtemp` directory; `CONTRACTS_DIR` is read-only, and `:452-453` re-asserts the committed corpus is unchanged afterwards.
3. **No production path admits the four contracts where it did not before** — verified independently rather than accepted. All four still fail `SprintContractSchema` on fields other than `status`: `successCriteria` is an array of plain strings where `SuccessCriterionSchema` requires objects (`sprint-contract.ts:165`), and `nonGoals`/`stopConditions`/`definitionOfDone` are absent though required (`:169,171,173`). So `listContracts` (`sprint-state.ts:137-140`) still drops them and `loadContract` still throws. The only two other raw-JSON contract readers (`pge/golden/__fixtures__/workload-build.ts:207`, `pge/engine/__fixtures__/real-workload.ts:59`) gate through the same schema.

`JSON.parse` is used (not eval/vm); parsed values are only read and handed to Zod, with no object merge or prototype assignment — no unsafe-deserialization or prototype-pollution path. Symlink-following in the corpus read is not flagged: it requires an attacker who already has write access to the working tree, the same trust boundary that supplies the test source itself, so it confers no additional capability.

# ADR-2: Loose-JSON Turn Classifier via jsonObjectMode

**Decision:** Classify each turn with one `LLMClient.chat` call using `jsonObjectMode: true` and tolerant parsing, NOT strict `responseSchema` json_schema nor tool-calling.

**Context:** Every turn must be classified into exactly one of {answer · spawn · steer/inspect-stop}, and the classification must behave identically on Anthropic and OpenAI-compatible (DeepSeek) providers.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Loose JSON via jsonObjectMode + tolerant parse | Works on both providers; one call; parse-fail degrades to "answer" | No schema enforcement; must tolerate malformed/extra fields |
| B. Strict responseSchema (json_schema) | Guaranteed shape | DeepSeek rejects strict json_schema typing (types.ts:177-178) — violates identical-classification criterion |
| C. Tool-calling answerer | Native structured output on Anthropic | DeepSeek tool-call fidelity is uneven; non-identical behaviour across providers |

**Rationale:** Checkpoint-1 success criterion "classifier/answerer runs identically through LLMClient.chat on Anthropic AND DeepSeek" eliminates B (DeepSeek rejects strict json_schema, types.ts:177-178) and C (uneven DeepSeek tool-call fidelity). `jsonObjectMode` is the one structured-output mode both providers honour.

**Consequences:** `TurnClassifier` returns a tolerant `ClassifierAction` union. Unknown/malformed output deterministically falls back to `{action:"answer"}`, never crashes a turn. One LLM call per turn satisfies the cost ceiling.

**Risk:** A genuinely-spawn turn misclassified as "answer" produces a chat reply instead of a worker; the user simply re-phrases. No silent data loss — fallback is the safe direction (never spuriously spawns or stops).

---
name: bober-diagnose
description: Use when investigating a production incident or system-level failure — gather evidence at component boundaries, hypothesize-and-disprove, verify resolution against pre-defined criteria
---

> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: skills/systematic-debugging/SKILL.md (four-phase discipline).
> Adaptations: system-level (incident) context; boundary enumeration as Phase 2; pre-defined resolution-verification criteria as Phase 4.

# Systematic Incident Diagnosis

## Overview

Random restarts mask root causes. Symptom-fixes destroy the ability to verify resolution. Reactive remediation without confirmed root cause prolongs incidents and introduces new failures.

**Core principle:** ALWAYS verify root cause at two independent boundaries before remediation.

**Violating the letter of this process is violating the spirit of incident response.**

## The Iron Law

```
NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES
```

If your evidence comes from a single component, you have a candidate hypothesis — not a verified root cause. Continue gathering at independent boundaries before proposing any remediation.

## When to Use

Use for ANY production incident:
- Error rate or latency regression
- Partial or total service outage
- Capacity event or unexpected resource exhaustion
- Data inconsistency or corruption report
- Security alert or anomalous traffic pattern
- Cascading failures across components

**Use this ESPECIALLY when:**
- Under time pressure (a page just fired — emergencies make guessing tempting)
- A restart "seems like it might help"
- The dashboard looks bad and everyone is watching
- You have one promising hypothesis and want to skip straight to fixing
- You've already tried one change and it didn't work

**Don't skip when:**
- Incident seems obvious ("it was the 14:00 deploy") — correlation must become causation via independent evidence
- Symptom looks simple (one endpoint, one user) — scope must be confirmed, not assumed
- Executive is watching — systematic diagnosis is FASTER than repeated rollbacks that don't fix the root cause

## The Four Phases

You MUST complete each phase before proceeding to the next. The gates between phases are not advisory — they are the process.

### Phase 1: Reproduce and Confirm

**BEFORE gathering evidence at component boundaries:**

1. **Confirm Symptom Is Current (not stale)**
   - Do NOT rely on the initial user report timestamp — that is when it was NOTICED, not necessarily when it is happening NOW.
   - Query an observability MCP at this moment: `obs__datadog__query_metric`, `obs__loki__query_logs`, or equivalent configured in `bober.config.json` → `observability.providers`.
   - If the symptom is no longer observable, record that — the incident may be self-resolved or intermittent. Do NOT proceed to Phase 2 on a stale symptom without confirming current status.

2. **Confirm Scope**
   - Is it one user, one customer, one region, one endpoint, or all of them?
   - Scope determines which component boundaries matter in Phase 2. A tenant-isolated failure points to tenant-specific data paths; a global failure points to shared infrastructure.
   - Record scope explicitly — "assumed global" is not confirmation.

3. **Confirm Timing**
   - When exactly did it start? (First alert timestamp ≠ first occurrence)
   - Has severity changed since it started — increasing, plateau, or decreasing?
   - Was there a deploy, config change, or infrastructure event within the relevant window? (Record as a potential correlation — not yet a cause.)

4. **Record Initial State to `observations.jsonl`**
   - Append each confirmed observation to `.bober/incidents/<id>/observations.jsonl` with the shape: `{timestamp, phase, observation, source, verified}`.
   - Do NOT record assumptions as observations. `"verified": true` means you queried a source and got the data; `"verified": false` means a user-reported claim not yet confirmed.

   **Worked example:**
   ```jsonl
   {"timestamp": "2026-05-24T14:05:00Z", "phase": 1, "observation": "Symptom: 500 errors on /api/checkout from 14:00 UTC; ~12% error rate; all regions", "source": "user-report", "verified": false}
   {"timestamp": "2026-05-24T14:06:00Z", "phase": 1, "observation": "Confirmed current via fresh metric query — error rate still 11.8% at 14:06", "source": "obs__datadog__query_metric", "verified": true}
   {"timestamp": "2026-05-24T14:07:00Z", "phase": 1, "observation": "Scope: all regions, all customers — global incident, not tenant-isolated", "source": "obs__datadog__query_metric", "verified": true}
   ```

<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 2, you MUST have completed Phase 1 in writing — symptom confirmed current, scope confirmed, timing confirmed, observations.jsonl appended. If any of these is incomplete, return to Phase 1. Skipping Phase 1 makes Phase 2 evidence-gathering ungrounded.
</EXTREMELY-IMPORTANT>

### Phase 2: Gather Evidence at Boundaries

**BEFORE forming hypotheses, gather at every relevant boundary:**

1. **Enumerate Component Boundaries**
   - Draw the request/data path end to end: `client → CDN → load balancer → API gateway → service → cache → database → storage`.
   - Each arrow between components is a boundary — a place where data crosses a trust or technology boundary and where failure can manifest differently on each side.
   - The scope confirmed in Phase 1 determines which boundaries are relevant. A global failure requires querying all boundaries. A single-region failure may skip globally-shared boundaries.

2. **Query at Each Boundary via Observability MCPs**
   - Use the `obs__<provider>__<tool>` namespace configured in `bober.config.json` → `observability.providers`.
   - Provider kinds: `logs | metrics | traces | errors | custom`.
   - Query examples per boundary layer:
     - CDN/network layer: `obs__cloudflare__query_analytics` — cache-hit rate, 5xx responses at edge
     - App-layer logs: `obs__loki__query_logs` — structured error logs, trace IDs
     - Infra metrics: `obs__datadog__query_metric` — CPU, memory, connection pool saturation
     - Distributed traces: `obs__tempo__query_traces` — end-to-end latency, where spans break
     - Error tracking: `obs__sentry__query_events` — exception types, frequency, first seen
   - Record each query result to `observations.jsonl` with `phase: 2` and the `obs__<provider>__<tool>` value as `source`.

3. **Correlate Timestamps with `changelog.jsonl`**
   - Read `.bober/incidents/<id>/changelog.jsonl` for recent deploys, config changes, and infrastructure events.
   - Cross-reference incident-start timestamp (confirmed in Phase 1) with deploy and change timestamps.
   - **CRITICAL:** Temporal correlation is not causation. A deploy 5 minutes before symptom onset is a hypothesis input, not a conclusion. Record it as a candidate, not a confirmed cause.

4. **Multi-Boundary Iron-Law Check**
   - Before any hypothesis becomes remediation-eligible, you MUST have evidence from at least TWO independent boundaries.
   - "Two log entries from the same service" is NOT two independent boundaries — that is one boundary queried twice.
   - Two independent boundaries means two different components in the system path, each providing telemetry that either supports or contradicts the same hypothesis.

<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 3, you MUST have queried at least two independent boundaries and recorded their findings as observations. If only one boundary has data, return to Phase 2 — Phase 3 hypothesis formation on single-boundary evidence violates the Iron Law.
</EXTREMELY-IMPORTANT>

### Phase 3: Hypothesize and Disprove

**Scientific method under pressure:**

1. **Formulate Falsifiable Hypotheses**
   - Each hypothesis is a single falsifiable claim: "The database connection pool is exhausted, causing checkout service to queue and timeout, explaining the 500 errors on /api/checkout."
   - Rank hypotheses by count of supporting evidence entries across independent boundaries — more independent boundary support = higher initial rank.
   - Drop hypotheses with zero evidence from Phase 2. Ungrounded hypotheses are guesses, not hypotheses.

2. **Pattern-Match Against the Anti-Pattern Catalog**
   - Before listing a hypothesis as a candidate, check `.bober/anti-patterns/README.md` for pattern matches.
   - Two anti-patterns are especially common in incidents: **Symptom-Fix Instead of Root-Cause** (see `root-cause-tracing.md`) and **Single-Layer Validation** (see `defense-in-depth.md`).
   - If your hypothesis matches one, cite the anti-pattern by name in your hypothesis record.

3. **ACTIVELY DISPROVE the Top Hypothesis** *(REQUIRED — not advisory)*
   - Try to find evidence that DISPROVES your top hypothesis. A hypothesis you cannot disprove is not strongly tested.
   - For each top hypothesis, ask: what would NOT be true if this hypothesis were correct? Go look for that evidence.
   - Example: if your hypothesis is "the 14:00 deploy caused the error spike," actively look for contradicting evidence — was the error rate elevated BEFORE 14:00? Is the same endpoint failing in a region that did NOT receive the 14:00 deploy? Are the error signatures different from what a rollout regression would produce?
   - Record the disproof attempt in `hypotheses.md` under the hypothesis. If you found contradicting evidence, demote the hypothesis. If you looked and found no contradicting evidence, the hypothesis survived the attempt — that is meaningful.
   - You MUST document what you checked and what you found (or did not find). "I tried to disprove it" without a recorded attempt is not a disproof attempt.

4. **Promote or Demote Confidence**
   - Promote a hypothesis to `confidence: 'high'` ONLY if: (a) evidence from ≥2 independent boundaries AND (b) survived an active disproof attempt with no contradicting evidence found.
   - Promote to `confidence: 'medium'` if: multi-boundary evidence but disproof attempt inconclusive (no contradicting evidence found, but also no strong confirming evidence).
   - Assign `confidence: 'low'` if: single-boundary evidence OR disproof attempt found partially contradicting evidence.
   - Only `confidence: 'medium'` or `confidence: 'high'` hypotheses are remediation-eligible. `confidence: 'low'` → return to Phase 2 for more evidence.
   - `blastRadius: 'risky'` remediation actions require `requiresApproval: true` — set this in the `nextActions` entry regardless of confidence level.

<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 4, you MUST have actively attempted to disprove your top hypothesis and recorded the attempt. A hypothesis that has NOT survived a disproof attempt is NOT remediation-eligible. If you have not yet tried to disprove it, return to Phase 3.
</EXTREMELY-IMPORTANT>

### Phase 4: Verify Resolution Against Pre-Defined Criteria

**Resolution criteria MUST be defined BEFORE remediation — retrofitted criteria are meaningless.**

1. **Pre-Define Resolution-Verification Criteria**
   - Before ANY state-mutating action, write the resolution criteria. All five fields are REQUIRED: metric, threshold, window, comparison baseline, verification source. Without all five, the criterion is not actionable.

   **Worked example:**
   ```
   Resolution criteria for inc-20260524-500-errors-on:
     - Metric: api.checkout.error_rate
     - Threshold: < 0.1%
     - Window: 10 minutes sustained
     - Comparison baseline: 7-day rolling average
     - Verification source: obs__datadog__query_metric
   ```

   - Record these criteria in `actions.jsonl` BEFORE the remediation action that follows.
   - Criteria written after the fact are retrofitted to the outcome and provide no verification value.

2. **Apply Remediation via bober-deployer**
   - NEVER run state-mutating commands from the diagnoser directly. The diagnoser emits a `nextActions` entry; the orchestrator routes it to `agents/bober-deployer.md` (Sprint 20 — `skills/bober.deploy/SKILL.md` once that sprint lands).
   - Actions classified `blastRadius: 'risky'` MUST include `requiresApproval: true` and will trigger a Tier 2 checkpoint gate before execution.
   - The deployer records each action in `changelog.jsonl` with a required `inverse` field — the rollback instruction for every state change.
   - See `skills/bober.deploy/SKILL.md` (Sprint 20) for the full remediation execution discipline.

3. **Monitor Against Criteria via Observability MCPs**
   - After remediation completes, begin monitoring the named metric using the named verification source.
   - Query at a cadence appropriate to the window (e.g., every 2 minutes for a 10-minute window).
   - Record each observation to `observations.jsonl` with `phase: 4`.
   - "The dashboard looks better" is NOT resolution. The criterion requires the named metric to meet the named threshold for the FULL named window.

4. **Mark Resolved Only When Criteria Met for the Named Window**
   - When the metric meets the threshold for the complete window duration, append resolution to `actions.jsonl` and update `incident.json` with `status: 'resolved'` and `resolvedAt`.
   - If criteria are not met within a reasonable monitoring period, or if the symptom returns, return to Phase 1 — the remediation was symptomatic, not root cause. The incident is not closed.
   - Explicitly forbidden: marking an incident resolved because the dashboard looks better, because a restart seemed to help, or because the page quieted down. These are not resolution criteria — they are noise.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "The dashboard looks better, mark it resolved"
- "Just restart the service and see if it helps"
- "It's obviously the database, skip the cache layer"
- "The deploy at 14:00 must be it, ship the rollback"
- "One log line is enough — I can see the error right there"
- "No time for hypothesis-disproof, the page is loud"
- "The metric is back to baseline, declare resolved"
- "Stale alert — the customer probably just refreshed"
- "I've seen this before, I know what it is"
- Proposing remediation before confirming evidence at two independent boundaries
- **"Just one restart to stabilize, then we'll investigate"**

**ALL of these mean: STOP. Return to Phase 1.**

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The dashboard looks green, we're resolved" | Resolution criteria require a NAMED metric meeting a NAMED threshold for a NAMED window. Eyeballing a dashboard is not verification. |
| "The deploy at 14:00 caused this — roll it back" | Correlation is not causation. Verify the deploy is the cause via independent telemetry before remediating. Rolling back the wrong thing extends the incident. |
| "Logs are unambiguous, one source is enough" | Iron Law: two independent boundaries. One source = continue gathering. Do not remediate on single-boundary evidence. |
| "No time to disprove the hypothesis, the page is loud" | Confirmation bias under pressure is the dominant incident-response failure mode. The disproof step exists EXACTLY for these moments. Skip it and you risk a second incident. |
| "Stale alert — the customer probably just refreshed" | Phase 1 requires CONFIRMING the symptom is current. "Probably refreshed" is not confirmation — query current state before proceeding. |
| "We'll set the resolution criteria after the fix lands" | Criteria set after the fix are retrofitted to the outcome. They MUST be pre-defined to be meaningful. Post-hoc criteria always pass. |
| "I've seen this before, skip to Phase 3" | Pattern memory is a hypothesis, not evidence. Phase 1 (confirm) and Phase 2 (boundaries) still produce the multi-source evidence required by the Iron Law. |
| "The MCP is slow, I'll just go from logs" | If a primary observability source is degraded, that is itself a diagnostic signal. Do NOT invent values for missing telemetry — low-confidence gaps are hypotheses, not evidence. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Reproduce + Confirm** | Confirm symptom current, confirm scope, confirm timing, write `observations.jsonl` | Symptom is real, scoped, and timed |
| **2. Gather at Boundaries** | Enumerate components; query `obs__<provider>__<tool>` at each boundary; correlate `changelog.jsonl` | Evidence at ≥2 independent boundaries |
| **3. Hypothesize + Disprove** | Rank hypotheses by evidence; pattern-match anti-catalog; actively seek contradicting evidence | Top hypothesis survived a recorded disproof attempt |
| **4. Verify Resolution** | Pre-define metric+threshold+window+baseline+source; remediate via bober-deployer; monitor; mark resolved | Criteria met for the full named window |

## When Process Reveals "No Root Cause"

If systematic investigation across all relevant boundaries turns up no root cause:

1. You have still completed the process — this is a valid outcome, not a process failure.
2. Document every boundary queried and every hypothesis disproved in `hypotheses.md`.
3. Implement appropriate defensive handling (circuit breaker, retry with backoff, graceful degradation).
4. Add monitoring for early detection of recurrence.

**But:** 95% of "no root cause" cases are incomplete boundary coverage. Check that Phase 2 covered every component in the request path before declaring no root cause.

## Related Skills

- **`bober.debug`** (`skills/bober.debug/SKILL.md`) — Use when the incident root cause turns out to be code-level (a test reproduces it, single component, deterministic). `bober.diagnose` handles "is the system broken?"; `bober.debug` handles "is the code wrong?". They are siblings, not parent-child. Used by `agents/bober-diagnoser.md`.
- **`bober.runbook`** (`skills/bober.runbook/SKILL.md`, Sprint 18) — When the diagnoser's next action is "follow runbook X", use `bober.runbook` for execution discipline (precondition → execute → postcondition for every step).
- **`bober.deploy`** (`skills/bober.deploy/SKILL.md`, Sprint 20) — Remediation execution via `agents/bober-deployer.md`. Required for any `blastRadius: 'risky'` action. Never run state-mutating commands from the diagnoser — always route through bober-deployer.
- **`.bober/anti-patterns/`** — Pattern catalog. Phase 3 hypothesis formation must check **Symptom-Fix Instead of Root-Cause** (`root-cause-tracing.md`) and **Single-Layer Validation** (`defense-in-depth.md`) for matches.

## Real-World Impact

From incident response patterns:
- Systematic diagnosis with disproof discipline: median time-to-resolution 20–40 minutes
- Restart-and-see approach: 2–4 hours of repeated remediation attempts, each buying 15 minutes of relief
- Retrofitted resolution criteria: re-opening rate ~60% within 24 hours
- Pre-defined resolution criteria with named window: re-opening rate ~8%

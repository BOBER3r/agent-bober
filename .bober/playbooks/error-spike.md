---
name: error-spike
classification: emergency
applicableSymptoms:
  - error rate spike
  - 5xx surge
  - 500 errors increasing
  - error budget burning
  - sli below objective
  - high error rate
  - error rate elevated
  - api errors spiking
  - service error rate high
prerequisites:
  - observability provider available (obs__<provider>__query_metric)
  - access to .bober/incidents/<id>/changelog.jsonl for recent deploys
  - ability to read service logs or traces
---

## Step 1: Gather error metrics across service boundaries
blastRadius: safe

precondition-check:
  - Observability provider accessible (at least one obs__<provider>__query_metric available)
  - Incident start timestamp available

execute:
  - obs__<provider>__query_metric — query error rate for: API gateway, application service, database layer (if applicable)
  - Record current error rate, baseline (pre-incident), and delta for each boundary
  - Query error rate time-series for the past 30 minutes to identify when the spike started
  - Record spike start timestamp in observations.jsonl

postcondition-check:
  - Error rate recorded for at least 2 independent service boundaries
  - Spike start timestamp identified (within ±5 minutes)
  - Metrics recorded in observations.jsonl

## Step 2: Correlate with recent deploys
blastRadius: safe

precondition-check:
  - Spike start timestamp from Step 1 available
  - .bober/incidents/<id>/changelog.jsonl readable

execute:
  - Read .bober/incidents/<id>/changelog.jsonl
  - Identify all deploy events in the 60 minutes before the spike start timestamp
  - Cross-reference deploy timestamp with spike start — flag any deploy within 15 minutes of spike onset as a 'strong correlate'
  - Also check for config changes, feature flag flips, or infrastructure events in the window

postcondition-check:
  - Correlation result recorded in observations.jsonl: list of deploys with time delta to spike
  - Strong correlates (< 15 min) flagged explicitly
  - 'No correlated deploy found' recorded if changelog is empty or no events in window

## Step 3: Identify scope — single endpoint vs cross-cutting
blastRadius: safe

precondition-check:
  - Error rate data from Step 1 available
  - At least one service boundary measured

execute:
  - Query per-endpoint or per-service error breakdown: which endpoints or services have elevated rates?
  - obs__<provider>__query_metric — filter by endpoint/route dimension
  - Classify scope:
    - single-endpoint: exactly one route or handler affected
    - service-wide: all endpoints of one service affected
    - cross-cutting: multiple independent services affected simultaneously
  - Record scope and affected endpoints in observations.jsonl

postcondition-check:
  - Scope classification recorded: single-endpoint / service-wide / cross-cutting
  - Affected endpoint(s) or service(s) named explicitly in observations.jsonl

## Step 4: Classify cause
blastRadius: safe

precondition-check:
  - Scope from Step 3 and correlation from Step 2 available
  - Error rate data and deploy correlation known

execute:
  - Classify probable cause using scope + correlation:
    - deploy-regression: strong correlate in Step 2 AND scope matches deployed service → rollback candidate
    - capacity-exhaustion: cross-cutting OR service-wide spike with no deploy correlate AND high CPU/memory/connection saturation
    - dependency-failure: single endpoint or service affected; downstream dependency (DB, cache, external API) returning errors
    - feature-flag-induced: deploy correlate is a flag flip; single-endpoint or service-wide
    - unknown: no correlate, no saturation signal, no dependency failure visible
  - Record classification and reasoning in observations.jsonl

postcondition-check:
  - Cause classification recorded as one of: deploy-regression / capacity-exhaustion / dependency-failure / feature-flag-induced / unknown
  - Reasoning references specific evidence from Steps 1–3

## Step 5: Execute remediation via deployer
blastRadius: risky

precondition-check:
  - Cause classification from Step 4 available
  - Remediation action determined; operator approval obtained (risky step)
  - If rollback: previous known-good version or commit identified

execute:
  - deploy-regression: trigger rollback to previous known-good version via deployer agent (requiresApproval=true)
  - capacity-exhaustion: scale up affected service via deployer (requiresApproval=true)
  - feature-flag-induced: flip flag to previous state via deployer (requiresApproval=true)
  - dependency-failure: surface as escalation with dependency name; triggering a downstream service restart may be appropriate (requiresApproval=true)
  - unknown: escalate via checkpoint with full evidence; do NOT take automated action without operator decision

postcondition-check:
  - Remediation action executed and recorded in changelog.jsonl
  - Error rate trend observable in metrics: downward slope or plateau expected within 5 minutes of action

rollback:
  - If rollback made error rate worse (post-deploy error rate > pre-rollback error rate): re-apply the reverted deploy and escalate
  - If scale-up did not relieve pressure: escalate; rate limiting or circuit breaker may be required

## Step 6: Verify error rate recovery
blastRadius: safe

precondition-check:
  - Remediation from Step 5 complete
  - At least 3 minutes elapsed since action (allow metric propagation)

execute:
  - obs__<provider>__query_metric — re-query error rate for affected boundary
  - Compare to pre-incident baseline
  - If error rate ≤ 1.5x baseline for 5 consecutive minutes: mark as recovering
  - If error rate still > 2x baseline: escalate; additional diagnosis required

postcondition-check:
  - Current error rate recorded in observations.jsonl with comparison to baseline
  - Trend recorded: 'recovering' / 'stable-elevated' / 'still-spiking'
  - If recovering: resolution criteria candidate defined for verifyResolution()

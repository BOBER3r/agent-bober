---
name: latency-regression
classification: standard
applicableSymptoms:
  - p95 latency increase
  - p99 latency spike
  - response time degradation
  - slow responses
  - latency regression
  - high latency
  - response time elevated
  - api slow
  - p50 latency increase
  - requests taking too long
prerequisites:
  - observability provider accessible (obs__<provider>__query_metric)
  - access to .bober/incidents/<id>/changelog.jsonl for recent deploys
  - resource metrics available (CPU, memory, connection pool counts)
---

## Step 1: Identify the affected service and latency baseline
blastRadius: safe

precondition-check:
  - Observability provider accessible
  - Incident symptom identifies affected service or endpoint (or 'all services')

execute:
  - obs__<provider>__query_metric — query p95 and p99 latency for suspected service(s) over last 30 minutes
  - Query baseline latency (same time window yesterday or 7-day rolling average)
  - Identify affected service name, affected endpoints, current p95/p99, and baseline p95/p99
  - Record delta (current - baseline) in observations.jsonl

postcondition-check:
  - Affected service(s) identified
  - Current p95 and p99 latency recorded
  - Baseline latency recorded (with source: yesterday / 7-day average)
  - Delta recorded in observations.jsonl

## Step 2: Check resource saturation
blastRadius: safe

precondition-check:
  - Affected service identified from Step 1

execute:
  - obs__<provider>__query_metric — query CPU utilization for affected service over incident window
  - obs__<provider>__query_metric — query memory utilization over incident window
  - Query connection pool saturation (active / max connections ratio) if service uses a database
  - Query thread pool / worker pool utilization if applicable
  - Identify if any resource is > 80% utilized — flag as 'saturated'

postcondition-check:
  - CPU, memory, connection pool metrics recorded in observations.jsonl
  - 'saturated' or 'not-saturated' classification recorded per resource
  - If saturated: resource name and current utilization % recorded

## Step 3: Check downstream dependencies
blastRadius: safe

precondition-check:
  - Affected service identified from Step 1

execute:
  - Identify downstream dependencies: database(s), caches, external APIs called by the affected service
  - obs__<provider>__query_metric — query latency for each dependency over incident window
  - Check database slow query log (if accessible) for queries > 1 second
  - Check cache hit rate — a drop in hit rate causes increased downstream DB load
  - Check external API response times via observability traces or logs
  - Record each dependency latency vs baseline

postcondition-check:
  - Downstream dependencies list recorded in observations.jsonl
  - Latency measurement recorded for each dependency
  - Any dependency with elevated latency flagged with its current vs baseline latency

## Step 4: Correlate with recent deploys
blastRadius: safe

precondition-check:
  - Latency increase start timestamp identified from Step 1
  - .bober/incidents/<id>/changelog.jsonl readable

execute:
  - Read .bober/incidents/<id>/changelog.jsonl
  - Identify deploys in the 60 minutes before latency increase started
  - Cross-reference with affected service — a deploy of the affected service within 15 minutes of onset is a strong correlate
  - Also check for config changes and feature flag flips
  - Record correlating events in observations.jsonl

postcondition-check:
  - Correlation result recorded: list of deploys with time delta to latency onset
  - Strong correlates (< 15 min) of the affected service flagged explicitly

## Step 5: Classify cause and decide remediation
blastRadius: safe

precondition-check:
  - Steps 1–4 completed; resource saturation, dependency latency, and deploy correlation available

execute:
  - Classify root cause:
    - capacity-exhaustion: resource saturated (CPU / memory / connections) AND no deploy correlate → scale up
    - downstream-bottleneck: dependency latency elevated AND no resource saturation in upstream service → investigate downstream
    - code-regression: deploy correlate within 15 min AND resource not saturated AND dependencies healthy → rollback candidate
    - cache-invalidation: cache hit rate drop AND DB latency elevated → cache warming or TTL issue
    - traffic-spike: all metrics elevated proportionally AND no deploy/dependency signal → rate limit or scale out
    - unknown: no clear signal from Steps 1–4 → escalate
  - Record classification and candidate remediation action

postcondition-check:
  - Cause classification recorded as one of: capacity-exhaustion / downstream-bottleneck / code-regression / cache-invalidation / traffic-spike / unknown
  - Candidate remediation action documented with requiresApproval flag

## Step 6: Execute remediation
blastRadius: risky

precondition-check:
  - Cause classification and remediation action from Step 5 available
  - Operator approval obtained (risky step)

execute:
  - capacity-exhaustion: scale up affected service via deployer (requiresApproval=true)
  - downstream-bottleneck: escalate to downstream service owner; if cache — warm cache or adjust TTL
  - code-regression: rollback to previous known-good version via deployer (requiresApproval=true)
  - cache-invalidation: trigger cache warm-up or force TTL extension (requiresApproval=true)
  - traffic-spike: adjust rate limits or scale out (requiresApproval=true)
  - unknown: escalate via checkpoint; do not act without operator decision

postcondition-check:
  - Remediation action recorded in changelog.jsonl
  - p95 latency observable in metrics; downward trend expected within 5 minutes of action

rollback:
  - If rollback increased latency further: re-apply the reverted version and escalate with full evidence
  - If scale-up did not relieve saturation within 10 minutes: escalate for capacity planning investigation

## Step 7: Verify latency recovery
blastRadius: safe

precondition-check:
  - Remediation from Step 6 complete
  - At least 5 minutes elapsed (allow metric propagation and service stabilization)

execute:
  - obs__<provider>__query_metric — re-query p95 and p99 latency for affected service
  - Compare to baseline from Step 1
  - If p95 ≤ 1.2x baseline for 5 consecutive minutes: mark as recovered
  - If p95 still > 2x baseline: escalate; additional diagnosis cycle required

postcondition-check:
  - Current p95 and p99 recorded in observations.jsonl with comparison to baseline
  - Trend recorded: 'recovered' / 'improving' / 'still-elevated'
  - If recovered: resolution criteria candidate defined for verifyResolution()

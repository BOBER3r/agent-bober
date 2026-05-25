---
name: build-failure
classification: standard
applicableSymptoms:
  - ci build fails
  - build red
  - compilation error
  - tests fail in ci
  - github actions failing
  - pipeline failing
  - build broken
prerequisites:
  - read access to CI logs (via obs__github__get_workflow_run or similar)
  - read access to repository
  - access to recent commit history
---

## Step 1: Identify the failing job
blastRadius: safe

precondition-check:
  - obs__github__list_workflow_runs available or CI dashboard accessible
  - Incident symptom identifies a failing build or pipeline

execute:
  - obs__github__list_workflow_runs — retrieve the most recent failed run ID
  - obs__github__get_workflow_run(runId) — get the failed job name and step

postcondition-check:
  - Failed job name and step recorded in observations.jsonl
  - Run ID available for subsequent steps

## Step 2: Fetch the failure logs
blastRadius: safe

precondition-check:
  - Failed job name and run ID available from Step 1

execute:
  - obs__github__get_workflow_logs(runId, jobName) — fetch log content for the failing step
  - Record log tail (last 200 lines) in observations.jsonl

postcondition-check:
  - Log content recorded in observations.jsonl
  - Error pattern visible in fetched log lines

## Step 3: Classify the failure
blastRadius: safe

precondition-check:
  - Logs from Step 2 available in observations.jsonl

execute:
  - Match log content against known patterns:
    - 'flaky test' / 'FLAKY' / intermittent failure keywords → classification: transient
    - 'compilation error' / 'SyntaxError' / 'TypeScript error' → classification: real-code-error
    - 'cannot find module' / 'dependency not found' / 'resolution failed' → classification: dependency-error
    - 'timeout' / 'exceeded time limit' / 'runner out of memory' → classification: infra-issue
    - 'test suite failed to run' / 'setup error' → classification: test-setup-error
    - none matched → classification: unknown
  - Record classification and matching pattern in observations.jsonl

postcondition-check:
  - Classification recorded in observations.jsonl as one of: transient / real-code-error / dependency-error / infra-issue / test-setup-error / unknown

## Step 4: Branch on classification and act
blastRadius: safe

precondition-check:
  - Classification available from Step 3

execute:
  - If transient: trigger a manual re-run of the failed job; record retry attempt
  - If real-code-error: record the offending file + line number from logs; surface as diagnosis nextAction with requiresApproval=true for engineer fix
  - If dependency-error: identify the unresolved package and version; surface as diagnosis nextAction for dependency resolution
  - If infra-issue: surface as escalation nextAction to infra team; do not retry automatically
  - If test-setup-error: identify the failing test fixture or seed; surface as diagnosis nextAction
  - If unknown: escalate to on-call engineer with full log excerpt

postcondition-check:
  - Action taken or escalation surfaced matches the classification
  - Outcome (retry triggered / fix surfaced / escalation sent) recorded in observations.jsonl

## Step 5: Correlate with recent commits
blastRadius: safe

precondition-check:
  - Incident ID available
  - Build failure classification from Step 3 is real-code-error or dependency-error

execute:
  - Read .bober/incidents/<id>/changelog.jsonl to identify deploys in the 60 minutes before the build failed
  - Correlate failing file or dependency with the commit that introduced it
  - obs__github__list_commits(since=incidentStartMinus60m) — cross-reference

postcondition-check:
  - Correlation result recorded: either a specific commit identified as the likely cause, or 'no correlated commit found'

## Step 6: Record outcome and close or escalate
blastRadius: safe

precondition-check:
  - Steps 1–5 completed; outcome determined

execute:
  - If build is re-green after retry or fix: record resolution in observations.jsonl; no further action
  - If build remains red after retry: escalate via checkpoint with full evidence summary
  - Record final classification, correlated commit (if any), and resolution path

postcondition-check:
  - Outcome recorded in observations.jsonl
  - If build resolved: CI shows green run after the fix/retry
  - If escalated: checkpoint entry created with evidence payload

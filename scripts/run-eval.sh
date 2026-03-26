#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# run-eval.sh — Run evaluation strategies from bober.config.json.
#
# Usage:
#   bash scripts/run-eval.sh [project-dir]
#
# Reads bober.config.json to determine which strategies to run,
# executes each in order, and outputs a combined JSON result.
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
CONFIG_FILE="$PROJECT_DIR/bober.config.json"

# ── Validate config ─────────────────────────────────────────────────

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: bober.config.json not found in $PROJECT_DIR" >&2
  echo "Run 'bober init' or 'bash scripts/init-project.sh <template>' first." >&2
  exit 1
fi

# ── Parse config ────────────────────────────────────────────────────
# We use lightweight parsing to avoid requiring jq as a dependency.
# For production use, the TypeScript evaluator handles full parsing.

# Extract commands from config
get_command() {
  local key="$1"
  local cmd
  cmd=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/')
  echo "$cmd"
}

CMD_BUILD="$(get_command "build")"
CMD_TEST="$(get_command "test")"
CMD_LINT="$(get_command "lint")"
CMD_TYPECHECK="$(get_command "typecheck")"

# ── Strategy Execution ──────────────────────────────────────────────

RESULTS=()
OVERALL_PASS=true
STRATEGY_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

run_strategy() {
  local strategy_type="$1"
  local required="$2"
  local command="$3"
  local status="skip"
  local output=""
  local exit_code=0

  STRATEGY_COUNT=$((STRATEGY_COUNT + 1))

  if [[ -z "$command" ]]; then
    echo "  [$strategy_type] SKIP — no command configured"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    status="skip"
    output="No command configured for $strategy_type"
  else
    echo "  [$strategy_type] Running: $command"

    set +e
    output=$(cd "$PROJECT_DIR" && eval "$command" 2>&1)
    exit_code=$?
    set -e

    if [[ $exit_code -eq 0 ]]; then
      echo "  [$strategy_type] PASS"
      status="pass"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "  [$strategy_type] FAIL (exit code $exit_code)"
      status="fail"
      FAIL_COUNT=$((FAIL_COUNT + 1))

      if [[ "$required" == "true" ]]; then
        OVERALL_PASS=false
      fi
    fi
  fi

  # Escape output for JSON (basic escaping)
  output=$(echo "$output" | head -50 | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ' | head -c 2000)

  RESULTS+=("{\"strategy\":\"$strategy_type\",\"status\":\"$status\",\"required\":$required,\"exitCode\":$exit_code,\"output\":\"$output\"}")
}

echo ""
echo "Running evaluations in $PROJECT_DIR"
echo "──────────────────────────────────────────────────────"
echo ""

# ── Extract and run strategies ──────────────────────────────────────
# Parse the strategies array from config. We look for type/required pairs.

# Run strategies in canonical order: typecheck -> lint -> build -> unit-test -> playwright

if grep -q '"typecheck"' "$CONFIG_FILE" 2>/dev/null; then
  required="true"
  grep -q '"type"[[:space:]]*:[[:space:]]*"typecheck"' "$CONFIG_FILE" && \
    grep -A1 '"typecheck"' "$CONFIG_FILE" | grep -q '"required"[[:space:]]*:[[:space:]]*false' && required="false"
  run_strategy "typecheck" "$required" "$CMD_TYPECHECK"
fi

if grep -q '"type"[[:space:]]*:[[:space:]]*"lint"' "$CONFIG_FILE" 2>/dev/null; then
  required="true"
  grep -A1 '"lint"' "$CONFIG_FILE" | grep -q '"required"[[:space:]]*:[[:space:]]*false' && required="false"
  run_strategy "lint" "$required" "$CMD_LINT"
fi

if grep -q '"type"[[:space:]]*:[[:space:]]*"build"' "$CONFIG_FILE" 2>/dev/null; then
  required="true"
  grep -A1 '"build"' "$CONFIG_FILE" | grep -q '"required"[[:space:]]*:[[:space:]]*false' && required="false"
  run_strategy "build" "$required" "$CMD_BUILD"
fi

if grep -q '"type"[[:space:]]*:[[:space:]]*"unit-test"' "$CONFIG_FILE" 2>/dev/null; then
  required="true"
  grep -A1 '"unit-test"' "$CONFIG_FILE" | grep -q '"required"[[:space:]]*:[[:space:]]*false' && required="false"
  run_strategy "unit-test" "$required" "$CMD_TEST"
fi

if grep -q '"type"[[:space:]]*:[[:space:]]*"playwright"' "$CONFIG_FILE" 2>/dev/null; then
  required="false"
  grep -A1 '"playwright"' "$CONFIG_FILE" | grep -q '"required"[[:space:]]*:[[:space:]]*true' && required="true"

  PLAYWRIGHT_CMD=""
  if [[ -f "$PROJECT_DIR/package.json" ]] && grep -q "playwright" "$PROJECT_DIR/package.json" 2>/dev/null; then
    PLAYWRIGHT_CMD="npx playwright test"
  fi
  run_strategy "playwright" "$required" "$PLAYWRIGHT_CMD"
fi

# ── Output combined result ──────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────────"

if [[ "$OVERALL_PASS" == "true" ]]; then
  echo "  RESULT: PASS ($PASS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped)"
else
  echo "  RESULT: FAIL ($PASS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped)"
fi

echo ""

# Build the JSON results array
RESULTS_JSON="["
for i in "${!RESULTS[@]}"; do
  [[ $i -gt 0 ]] && RESULTS_JSON+=","
  RESULTS_JSON+="${RESULTS[$i]}"
done
RESULTS_JSON+="]"

# Output combined result as JSON
cat <<EOF
{
  "overall": "$( [[ "$OVERALL_PASS" == "true" ]] && echo "pass" || echo "fail" )",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projectDir": "$PROJECT_DIR",
  "strategiesRun": $STRATEGY_COUNT,
  "passed": $PASS_COUNT,
  "failed": $FAIL_COUNT,
  "skipped": $SKIP_COUNT,
  "results": $RESULTS_JSON
}
EOF

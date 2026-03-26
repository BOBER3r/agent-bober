#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# check-prereqs.sh — Validate prerequisites for a bober command
#
# Usage:
#   check-prereqs.sh <command> [project-root]
#
# Output: JSON with status and missing items
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared utilities
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

COMMAND="${1:-}"
PROJECT_ROOT="${2:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

if [[ -z "$COMMAND" ]]; then
  echo "Usage: check-prereqs.sh <command> [project-root]"
  echo ""
  echo "Commands: plan, sprint, eval, run, principles"
  exit 1
fi

# ── Collect checks ─────────────────────────────────────────────────

CHECKS=()
READY=true

# Helper to add a check result and track readiness
add_check() {
  local json="$1"
  CHECKS+=("$json")
  if echo "$json" | grep -q '"status":"missing"' || echo "$json" | grep -q '"status":"empty"'; then
    READY=false
  fi
}

# ── Common check: bober.config.json ───────────────────────────────

config_check=$(check_file "config" "$PROJECT_ROOT/bober.config.json")
add_check "$config_check"

# ── Common check: .bober/ directory ───────────────────────────────

if [ -d "$PROJECT_ROOT/.bober" ]; then
  add_check "{\"name\":\"bober_dir\",\"status\":\"ok\",\"path\":\".bober/\"}"
else
  add_check "{\"name\":\"bober_dir\",\"status\":\"missing\",\"path\":\".bober/\",\"message\":\"No .bober/ directory. Run /bober-plan first.\"}"
fi

# ── Command-specific checks ───────────────────────────────────────

case "$COMMAND" in
  plan)
    # plan only needs bober.config.json (already checked above)
    ;;

  sprint)
    # Needs specs and contracts
    if [ -d "$PROJECT_ROOT/.bober/specs" ]; then
      spec_check=$(check_dir_has_files "specs" "$PROJECT_ROOT/.bober/specs" "*.json")
      add_check "$spec_check"
    else
      add_check "{\"name\":\"specs\",\"status\":\"missing\",\"message\":\"No .bober/specs/ directory. Run /bober-plan first.\"}"
    fi

    if [ -d "$PROJECT_ROOT/.bober/contracts" ]; then
      contract_check=$(check_dir_has_files "contracts" "$PROJECT_ROOT/.bober/contracts" "*.json")
      add_check "$contract_check"
    else
      add_check "{\"name\":\"contracts\",\"status\":\"missing\",\"message\":\"No .bober/contracts/ directory. Run /bober-plan first.\"}"
    fi
    ;;

  eval)
    # Needs contracts and code changes
    if [ -d "$PROJECT_ROOT/.bober/contracts" ]; then
      contract_check=$(check_dir_has_files "contracts" "$PROJECT_ROOT/.bober/contracts" "*.json")
      add_check "$contract_check"
    else
      add_check "{\"name\":\"contracts\",\"status\":\"missing\",\"message\":\"No .bober/contracts/ directory. Run /bober-plan first.\"}"
    fi

    # Check for code changes (git diff)
    if command -v git &>/dev/null && [ -d "$PROJECT_ROOT/.git" ]; then
      changes=$(cd "$PROJECT_ROOT" && git diff --stat 2>/dev/null | wc -l | tr -d ' ')
      if [ "$changes" -gt 0 ]; then
        add_check "{\"name\":\"code_changes\",\"status\":\"ok\",\"count\":$changes}"
      else
        add_check "{\"name\":\"code_changes\",\"status\":\"empty\",\"count\":0,\"message\":\"No code changes detected. Run /bober-sprint first.\"}"
      fi
    fi
    ;;

  run)
    # run only needs bober.config.json (creates everything else)
    ;;

  principles)
    # principles only needs bober.config.json (already checked above)
    ;;

  *)
    json_output "error" "Unknown command: $COMMAND. Valid commands: plan, sprint, eval, run, principles"
    exit 1
    ;;
esac

# ── Build output JSON ──────────────────────────────────────────────

CHECKS_JSON="["
for i in "${!CHECKS[@]}"; do
  [[ $i -gt 0 ]] && CHECKS_JSON+=","
  CHECKS_JSON+="${CHECKS[$i]}"
done
CHECKS_JSON+="]"

if [[ "$READY" == "true" ]]; then
  MESSAGE="Ready to run"
else
  MESSAGE="Missing prerequisites"
fi

cat <<EOF
{
  "ready": $READY,
  "command": "$COMMAND",
  "projectRoot": "$PROJECT_ROOT",
  "checks": $CHECKS_JSON,
  "message": "$MESSAGE"
}
EOF

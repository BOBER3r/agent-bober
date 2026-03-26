#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# common.sh — Shared utilities for bober scripts
# ──────────────────────────────────────────────────────────────────────

# Output JSON helper
json_output() {
  local status="$1"
  local message="$2"
  echo "{\"status\":\"${status}\",\"message\":\"${message}\"}"
}

# Find project root (walk up looking for bober.config.json)
find_project_root() {
  local dir="${1:-.}"
  dir="$(cd "$dir" && pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/bober.config.json" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Check if a file exists and report
check_file() {
  local name="$1"
  local path="$2"
  if [ -f "$path" ]; then
    echo "{\"name\":\"${name}\",\"status\":\"ok\",\"path\":\"${path}\"}"
  else
    echo "{\"name\":\"${name}\",\"status\":\"missing\",\"path\":\"${path}\"}"
  fi
}

# Check if directory has files matching a pattern
check_dir_has_files() {
  local name="$1"
  local dir="$2"
  local pattern="${3:-*}"
  local count
  count=$(find "$dir" -name "$pattern" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    echo "{\"name\":\"${name}\",\"status\":\"ok\",\"count\":${count}}"
  else
    echo "{\"name\":\"${name}\",\"status\":\"empty\",\"count\":0}"
  fi
}

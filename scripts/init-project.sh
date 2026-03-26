#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# init-project.sh — Initialize a new bober-managed project.
#
# Usage:
#   bash scripts/init-project.sh <template>
#
# Templates: react-fullstack, brownfield, generic
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$PACKAGE_ROOT/templates"
PROJECT_DIR="$(pwd)"

# ── Argument validation ─────────────────────────────────────────────

TEMPLATE="${1:-}"

if [[ -z "$TEMPLATE" ]]; then
  echo "Usage: bash scripts/init-project.sh <template>"
  echo ""
  echo "Available templates:"
  echo "  react-fullstack   React 19 + Vite + Express + TypeScript"
  echo "  brownfield        Existing codebase (conservative settings)"
  echo "  generic           Minimal configuration (customize yourself)"
  exit 1
fi

TEMPLATE_DIR="$TEMPLATES_DIR/$TEMPLATE"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Error: Unknown template '$TEMPLATE'."
  echo "Available templates: react-fullstack, brownfield, generic"
  exit 1
fi

echo "Initializing bober project with template: $TEMPLATE"
echo "Project directory: $PROJECT_DIR"
echo ""

# ── Create .bober directory structure ───────────────────────────────

echo "Creating .bober/ directory structure..."

mkdir -p "$PROJECT_DIR/.bober/specs"
mkdir -p "$PROJECT_DIR/.bober/contracts"
mkdir -p "$PROJECT_DIR/.bober/evaluations"
mkdir -p "$PROJECT_DIR/.bober/snapshots"

# Initialize progress tracker
if [[ ! -f "$PROJECT_DIR/.bober/progress.md" ]]; then
  cat > "$PROJECT_DIR/.bober/progress.md" << 'PROGRESS'
# Bober Progress

Tracking all plans, sprints, and evaluations.

---

PROGRESS
  echo "  Created .bober/progress.md"
fi

# Initialize history log
if [[ ! -f "$PROJECT_DIR/.bober/history.jsonl" ]]; then
  echo "{\"event\":\"project-initialized\",\"template\":\"$TEMPLATE\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    > "$PROJECT_DIR/.bober/history.jsonl"
  echo "  Created .bober/history.jsonl"
fi

# ── Copy bober.config.json ──────────────────────────────────────────

if [[ -f "$PROJECT_DIR/bober.config.json" ]]; then
  echo "  bober.config.json already exists — skipping (will not overwrite)"
else
  # Determine the project name from the directory name
  PROJECT_NAME="$(basename "$PROJECT_DIR")"
  # Copy and substitute the project name
  sed "s/\"name\": \"\"/\"name\": \"$PROJECT_NAME\"/" \
    "$TEMPLATE_DIR/bober.config.json" > "$PROJECT_DIR/bober.config.json"
  echo "  Created bober.config.json"
fi

# ── Copy CLAUDE.md ──────────────────────────────────────────────────

if [[ -f "$PROJECT_DIR/CLAUDE.md" ]]; then
  echo "  CLAUDE.md already exists — skipping (will not overwrite)"
else
  cp "$TEMPLATE_DIR/CLAUDE.md" "$PROJECT_DIR/CLAUDE.md"
  echo "  Created CLAUDE.md"
fi

# ── Copy scaffold files (react-fullstack only) ─────────────────────

if [[ -d "$TEMPLATE_DIR/scaffold" ]]; then
  echo ""
  echo "Copying scaffold files..."

  # Only copy scaffold files that do not already exist
  while IFS= read -r -d '' file; do
    relative="${file#$TEMPLATE_DIR/scaffold/}"
    target="$PROJECT_DIR/$relative"
    target_dir="$(dirname "$target")"

    if [[ -f "$target" ]]; then
      echo "  Skipping $relative (already exists)"
    else
      mkdir -p "$target_dir"
      cp "$file" "$target"
      echo "  Created $relative"
    fi
  done < <(find "$TEMPLATE_DIR/scaffold" -type f -print0)
fi

# ── Update .gitignore ───────────────────────────────────────────────

echo ""
echo "Updating .gitignore..."

GITIGNORE="$PROJECT_DIR/.gitignore"

# Entries to ensure are present
ENTRIES=(
  ".bober/"
  ".bober/snapshots/"
)

touch "$GITIGNORE"

for entry in "${ENTRIES[@]}"; do
  if ! grep -qxF "$entry" "$GITIGNORE" 2>/dev/null; then
    echo "$entry" >> "$GITIGNORE"
    echo "  Added '$entry' to .gitignore"
  fi
done

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────────"
echo "  bober project initialized successfully!"
echo "──────────────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo ""

if [[ "$TEMPLATE" == "react-fullstack" ]]; then
  echo "  1. npm install"
  echo "  2. npm run dev              # start frontend + backend"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "brownfield" ]]; then
  echo "  1. Review bober.config.json and update the 'commands' section"
  echo "     with your project's build, test, lint, and dev commands."
  echo "  2. /bober:plan              # create your first plan"
  echo "  3. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "generic" ]]; then
  echo "  1. Edit bober.config.json to match your project setup."
  echo "  2. Edit CLAUDE.md with your project's conventions."
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
fi

echo ""
echo "Run /bober:plan to start planning your first feature."

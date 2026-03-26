#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# init-project.sh — Initialize a new bober-managed project.
#
# Usage:
#   bash scripts/init-project.sh <template>
#
# Templates: base, brownfield
# Presets:   nextjs, react-vite, solidity, anchor, api-node, python-api
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
  echo "  base            Minimal greenfield configuration (customize yourself)"
  echo "  brownfield      Existing codebase (conservative settings)"
  echo ""
  echo "Available presets:"
  echo "  nextjs          Next.js full-stack app"
  echo "  react-vite      React + Vite + any backend"
  echo "  solidity        EVM smart contracts (Hardhat/Foundry)"
  echo "  anchor          Solana programs (Anchor/Rust)"
  echo "  api-node        Node.js API (Express/NestJS/Fastify)"
  echo "  python-api      Python API (FastAPI/Django)"
  exit 1
fi

# Resolve template directory — presets live under templates/presets/
if [[ "$TEMPLATE" == "base" || "$TEMPLATE" == "brownfield" ]]; then
  TEMPLATE_DIR="$TEMPLATES_DIR/$TEMPLATE"
else
  TEMPLATE_DIR="$TEMPLATES_DIR/presets/$TEMPLATE"
fi

if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Error: Unknown template '$TEMPLATE'."
  echo "Available templates: base, brownfield"
  echo "Available presets: nextjs, react-vite, solidity, anchor, api-node, python-api"
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

# ── Copy scaffold files (preset templates with scaffold dirs) ───────

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

if [[ "$TEMPLATE" == "react-vite" ]]; then
  echo "  1. npm install"
  echo "  2. npm run dev              # start frontend + backend"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "nextjs" ]]; then
  echo "  1. npm install"
  echo "  2. npm run dev              # start Next.js dev server"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "solidity" ]]; then
  echo "  1. npm install"
  echo "  2. npx hardhat compile      # compile contracts"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "anchor" ]]; then
  echo "  1. anchor build             # build the program"
  echo "  2. anchor test              # run tests"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "api-node" ]]; then
  echo "  1. npm install"
  echo "  2. npm run dev              # start the API server"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "python-api" ]]; then
  echo "  1. pip install -r requirements.txt  # or: poetry install"
  echo "  2. uvicorn app.main:app --reload    # start the API server"
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "brownfield" ]]; then
  echo "  1. Review bober.config.json and update the 'commands' section"
  echo "     with your project's build, test, lint, and dev commands."
  echo "  2. /bober:plan              # create your first plan"
  echo "  3. /bober:sprint            # run the first sprint"
elif [[ "$TEMPLATE" == "base" ]]; then
  echo "  1. Edit bober.config.json to match your project setup."
  echo "  2. Edit CLAUDE.md with your project's conventions."
  echo "  3. /bober:plan              # create your first plan"
  echo "  4. /bober:sprint            # run the first sprint"
fi

echo ""
echo "Run /bober:plan to start planning your first feature."

# ── Structured JSON summary ────────────────────────────────────────

CREATED_FILES=()
[[ -f "$PROJECT_DIR/.bober/progress.md" ]] && CREATED_FILES+=("\".bober/progress.md\"")
[[ -f "$PROJECT_DIR/.bober/history.jsonl" ]] && CREATED_FILES+=("\".bober/history.jsonl\"")
[[ -f "$PROJECT_DIR/bober.config.json" ]] && CREATED_FILES+=("\"bober.config.json\"")
[[ -f "$PROJECT_DIR/CLAUDE.md" ]] && CREATED_FILES+=("\"CLAUDE.md\"")

CREATED_JSON="["
for i in "${!CREATED_FILES[@]}"; do
  [[ $i -gt 0 ]] && CREATED_JSON+=","
  CREATED_JSON+="${CREATED_FILES[$i]}"
done
CREATED_JSON+="]"

CREATED_DIRS=()
[[ -d "$PROJECT_DIR/.bober/specs" ]] && CREATED_DIRS+=("\".bober/specs/\"")
[[ -d "$PROJECT_DIR/.bober/contracts" ]] && CREATED_DIRS+=("\".bober/contracts/\"")
[[ -d "$PROJECT_DIR/.bober/evaluations" ]] && CREATED_DIRS+=("\".bober/evaluations/\"")
[[ -d "$PROJECT_DIR/.bober/snapshots" ]] && CREATED_DIRS+=("\".bober/snapshots/\"")

DIRS_JSON="["
for i in "${!CREATED_DIRS[@]}"; do
  [[ $i -gt 0 ]] && DIRS_JSON+=","
  DIRS_JSON+="${CREATED_DIRS[$i]}"
done
DIRS_JSON+="]"

echo ""
cat <<INIT_JSON
{
  "status": "ok",
  "template": "$TEMPLATE",
  "projectDir": "$PROJECT_DIR",
  "projectName": "$(basename "$PROJECT_DIR")",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "createdFiles": $CREATED_JSON,
  "createdDirs": $DIRS_JSON,
  "message": "Project initialized successfully with template: $TEMPLATE"
}
INIT_JSON

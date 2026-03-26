#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# detect-stack.sh — Auto-detect the technology stack of a project.
#
# Usage:
#   bash scripts/detect-stack.sh [project-dir]
#
# If no directory is given, uses the current working directory.
# Outputs a JSON object describing the detected stack.
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# ── Helpers ─────────────────────────────────────────────────────────

# Check if a file exists in the project
has_file() {
  [[ -f "$PROJECT_DIR/$1" ]]
}

# Check if package.json contains a dependency (dev or prod)
has_dep() {
  if has_file "package.json"; then
    grep -q "\"$1\"" "$PROJECT_DIR/package.json" 2>/dev/null
  else
    return 1
  fi
}

# ── Language Detection ──────────────────────────────────────────────

LANGUAGES=()

if has_file "package.json"; then
  LANGUAGES+=("javascript")
fi

if has_file "tsconfig.json" || has_dep "typescript"; then
  LANGUAGES+=("typescript")
fi

if has_file "requirements.txt" || has_file "pyproject.toml" || has_file "Pipfile" || has_file "setup.py"; then
  LANGUAGES+=("python")
fi

if has_file "go.mod"; then
  LANGUAGES+=("go")
fi

if has_file "Cargo.toml"; then
  LANGUAGES+=("rust")
fi

if has_file "pom.xml" || has_file "build.gradle" || has_file "build.gradle.kts"; then
  LANGUAGES+=("java")
fi

if has_file "mix.exs"; then
  LANGUAGES+=("elixir")
fi

if has_file "Gemfile"; then
  LANGUAGES+=("ruby")
fi

# ── Framework Detection ─────────────────────────────────────────────

FRAMEWORKS=()

if has_dep "react"; then
  FRAMEWORKS+=("react")
fi

if has_dep "vue"; then
  FRAMEWORKS+=("vue")
fi

if has_dep "@angular/core"; then
  FRAMEWORKS+=("angular")
fi

if has_dep "svelte"; then
  FRAMEWORKS+=("svelte")
fi

if has_dep "next"; then
  FRAMEWORKS+=("nextjs")
fi

if has_dep "nuxt"; then
  FRAMEWORKS+=("nuxt")
fi

if has_dep "astro"; then
  FRAMEWORKS+=("astro")
fi

if has_dep "remix" || has_dep "@remix-run/node"; then
  FRAMEWORKS+=("remix")
fi

if has_dep "express"; then
  FRAMEWORKS+=("express")
fi

if has_dep "fastify"; then
  FRAMEWORKS+=("fastify")
fi

if has_dep "hono"; then
  FRAMEWORKS+=("hono")
fi

if has_dep "koa"; then
  FRAMEWORKS+=("koa")
fi

if has_dep "nestjs" || has_dep "@nestjs/core"; then
  FRAMEWORKS+=("nestjs")
fi

# Python frameworks
if has_file "requirements.txt" || has_file "pyproject.toml"; then
  COMBINED=""
  [[ -f "$PROJECT_DIR/requirements.txt" ]] && COMBINED+="$(cat "$PROJECT_DIR/requirements.txt")"
  [[ -f "$PROJECT_DIR/pyproject.toml" ]] && COMBINED+="$(cat "$PROJECT_DIR/pyproject.toml")"

  echo "$COMBINED" | grep -qi "django" && FRAMEWORKS+=("django")
  echo "$COMBINED" | grep -qi "flask" && FRAMEWORKS+=("flask")
  echo "$COMBINED" | grep -qi "fastapi" && FRAMEWORKS+=("fastapi")
fi

# ── Test Framework Detection ────────────────────────────────────────

TEST_FRAMEWORKS=()

if has_dep "vitest"; then
  TEST_FRAMEWORKS+=("vitest")
fi

if has_dep "jest"; then
  TEST_FRAMEWORKS+=("jest")
fi

if has_dep "mocha"; then
  TEST_FRAMEWORKS+=("mocha")
fi

if has_dep "@playwright/test"; then
  TEST_FRAMEWORKS+=("playwright")
fi

if has_dep "cypress"; then
  TEST_FRAMEWORKS+=("cypress")
fi

if has_dep "@testing-library/react" || has_dep "@testing-library/vue"; then
  TEST_FRAMEWORKS+=("testing-library")
fi

# Python test frameworks
if has_file "requirements.txt" || has_file "pyproject.toml" || has_file "setup.cfg"; then
  for f in requirements.txt pyproject.toml setup.cfg; do
    if has_file "$f" && grep -qi "pytest" "$PROJECT_DIR/$f" 2>/dev/null; then
      TEST_FRAMEWORKS+=("pytest")
      break
    fi
  done
fi

# Go testing is built-in; check for testify
if has_file "go.mod" && grep -q "testify" "$PROJECT_DIR/go.mod" 2>/dev/null; then
  TEST_FRAMEWORKS+=("testify")
fi

# ── Linter Detection ───────────────────────────────────────────────

LINTERS=()

if has_dep "eslint" || has_file ".eslintrc.json" || has_file ".eslintrc.js" || has_file "eslint.config.js" || has_file "eslint.config.mjs"; then
  LINTERS+=("eslint")
fi

if has_dep "@biomejs/biome" || has_file "biome.json" || has_file "biome.jsonc"; then
  LINTERS+=("biome")
fi

if has_dep "prettier" || has_file ".prettierrc" || has_file ".prettierrc.json" || has_file "prettier.config.js"; then
  LINTERS+=("prettier")
fi

if has_file ".pylintrc" || has_file "pyproject.toml"; then
  if has_file "pyproject.toml" && grep -qi "ruff" "$PROJECT_DIR/pyproject.toml" 2>/dev/null; then
    LINTERS+=("ruff")
  fi
  if has_file ".pylintrc"; then
    LINTERS+=("pylint")
  fi
fi

if has_file ".golangci.yml" || has_file ".golangci.yaml"; then
  LINTERS+=("golangci-lint")
fi

# ── Build Tool Detection ───────────────────────────────────────────

BUILD_TOOLS=()

if has_dep "vite" || has_file "vite.config.ts" || has_file "vite.config.js"; then
  BUILD_TOOLS+=("vite")
fi

if has_dep "webpack" || has_file "webpack.config.js" || has_file "webpack.config.ts"; then
  BUILD_TOOLS+=("webpack")
fi

if has_dep "esbuild"; then
  BUILD_TOOLS+=("esbuild")
fi

if has_dep "turbo" || has_file "turbo.json"; then
  BUILD_TOOLS+=("turborepo")
fi

if has_dep "rollup" || has_file "rollup.config.js" || has_file "rollup.config.mjs"; then
  BUILD_TOOLS+=("rollup")
fi

if has_dep "tsup"; then
  BUILD_TOOLS+=("tsup")
fi

if has_file "Makefile"; then
  BUILD_TOOLS+=("make")
fi

if has_file "Dockerfile" || has_file "docker-compose.yml" || has_file "docker-compose.yaml"; then
  BUILD_TOOLS+=("docker")
fi

# ── Package Manager Detection ──────────────────────────────────────

PACKAGE_MANAGER="unknown"

if has_file "pnpm-lock.yaml"; then
  PACKAGE_MANAGER="pnpm"
elif has_file "yarn.lock"; then
  PACKAGE_MANAGER="yarn"
elif has_file "bun.lockb" || has_file "bun.lock"; then
  PACKAGE_MANAGER="bun"
elif has_file "package-lock.json"; then
  PACKAGE_MANAGER="npm"
elif has_file "package.json"; then
  PACKAGE_MANAGER="npm"
fi

# ── Output JSON ─────────────────────────────────────────────────────

json_array() {
  local arr=("$@")
  if [[ ${#arr[@]} -eq 0 ]]; then
    echo "[]"
    return
  fi
  local result="["
  for i in "${!arr[@]}"; do
    [[ $i -gt 0 ]] && result+=","
    result+="\"${arr[$i]}\""
  done
  result+="]"
  echo "$result"
}

cat <<EOF
{
  "projectDir": "$PROJECT_DIR",
  "languages": $(json_array "${LANGUAGES[@]+"${LANGUAGES[@]}"}"),
  "frameworks": $(json_array "${FRAMEWORKS[@]+"${FRAMEWORKS[@]}"}"),
  "testFrameworks": $(json_array "${TEST_FRAMEWORKS[@]+"${TEST_FRAMEWORKS[@]}"}"),
  "linters": $(json_array "${LINTERS[@]+"${LINTERS[@]}"}"),
  "buildTools": $(json_array "${BUILD_TOOLS[@]+"${BUILD_TOOLS[@]}"}"),
  "packageManager": "$PACKAGE_MANAGER"
}
EOF

#!/usr/bin/env bash
# t.gate.sh — pre-commit validation gate for pi-ember-stack
#
# Usage:
#   ./t.gate.sh                  # check everything (lint + typecheck + tests)
#   ./t.gate.sh <files...>       # check specific files (lint + typecheck only)
#
# Exits non-zero if any check fails. Run from the repo root.

set -euo pipefail

cd "$(dirname "$0")"

PASS=0
FAIL=0

step() {
	printf "\n\033[1;34m▶ %s\033[0m\n" "$1"
}

ok() {
	printf "  \033[1;32m✓ %s\033[0m\n" "$1"
	PASS=$((PASS + 1))
}

fail() {
	printf "  \033[1;31m✗ %s\033[0m\n" "$1"
	FAIL=$((FAIL + 1))
}

# ---------------------------------------------------------------------------
# Lint (Biome) — catches unused vars, import protocol, formatting drift
# ---------------------------------------------------------------------------
step "lint (biome)"
if npx biome lint --max-diagnostics=500 2>&1; then
	ok "biome lint"
else
	fail "biome lint"
fi

# ---------------------------------------------------------------------------
# Typecheck (tsc) — strict type safety
# ---------------------------------------------------------------------------
step "typecheck (tsc)"
if npm run typecheck 2>&1; then
	ok "tsc typecheck"
else
	fail "tsc typecheck"
fi

# ---------------------------------------------------------------------------
# Tests (Bun) — renderer + grouping regression coverage
# ---------------------------------------------------------------------------
if [ "$#" -eq 0 ]; then
	step "tests (bun)"
	if bun test plugins/pi-compact-tools plugins/pi-ember-fff plugins/pi-custom-agents plugins/pi-ember-tps 2>&1; then
		ok "bun tests"
	else
		fail "bun tests"
	fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n\033[1m"
if [ "$FAIL" -eq 0 ]; then
	printf "\033[1;32mall gates passed (%d)\033[0m\n" "$PASS"
	exit 0
else
	printf "\033[1;31m%d gate(s) failed, %d passed\033[0m\n" "$FAIL" "$PASS"
	exit 1
fi

#!/usr/bin/env bash
# erp-hr-backend/scripts/gate-p1.sh — ARCH-EXEC-01 §7 Phase-1 gate.
#
# Runs identically in two layouts:
#   1. Inside the /erp/ mono-workspace (local dev): sources the shared
#      helper at $WORKSPACE_ROOT/scripts/gate-p1-common.sh and writes the
#      verdict JSON to $WORKSPACE_ROOT/coordination/gates/.
#   2. Standalone checkout (GitHub Actions, A-QA E-10 clean clone): falls
#      back to the vendored helper next to this script and writes the
#      verdict JSON under <repo>/coordination/gates/ so the CI workflow
#      can upload it as an artifact.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Pick WORKSPACE_ROOT in this order:
#   - whatever the caller exports
#   - the mono-workspace parent if it actually exists
#   - the repo root (standalone mode)
if [ -z "${WORKSPACE_ROOT:-}" ]; then
  if [ -d "$REPO_ROOT/../coordination" ]; then
    WORKSPACE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
  else
    WORKSPACE_ROOT="$REPO_ROOT"
  fi
fi
export WORKSPACE_ROOT

# Prefer the workspace-level helper so local dev tracks the canonical
# version; fall back to the vendored copy in this repo for standalone runs.
COMMON="$WORKSPACE_ROOT/scripts/gate-p1-common.sh"
if [ ! -f "$COMMON" ]; then
  COMMON="$REPO_ROOT/scripts/gate-p1-common.sh"
fi
# shellcheck disable=SC1090
source "$COMMON"
gate_init "erp-hr-backend"

gate_step "unit"     "node --experimental-vm-modules node_modules/jest/bin/jest.js --passWithNoTests --silent --colors=false"
# lint and boundary start narrow: ESLint flat-config + dep-cruiser are
# wired only to the P1B foundation layer (src/lib/**, the health router,
# and their tests). Subsequent A-HR lanes widen the file scope as the
# rest of the service is brought up to the same bar — flipping to
# stricter coverage here would surface unrelated cross-cutting debt.
gate_step "lint"     "npx --no-install eslint --max-warnings 0"
gate_step "boundary" "npx --no-install depcruise src/lib --config .dependency-cruiser.cjs"
gate_step "security" "gate_default_secret_grep src"

gate_emit

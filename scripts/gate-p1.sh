#!/usr/bin/env bash
# erp-hr-backend/scripts/gate-p1.sh — ARCH-EXEC-01 §7 Phase-1 gate.
set -u
: "${WORKSPACE_ROOT:=/Users/mac/Desktop/Abdullah/erp}"
# shellcheck disable=SC1091
source "$WORKSPACE_ROOT/scripts/gate-p1-common.sh"
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

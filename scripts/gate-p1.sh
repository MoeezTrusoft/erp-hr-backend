#!/usr/bin/env bash
# erp-hr-backend/scripts/gate-p1.sh — ARCH-EXEC-01 §7 Phase-1 gate.
set -u
: "${WORKSPACE_ROOT:=/Users/mac/Desktop/Abdullah/erp}"
# shellcheck disable=SC1091
source "$WORKSPACE_ROOT/scripts/gate-p1-common.sh"
gate_init "erp-hr-backend"

gate_step "unit"     "node --experimental-vm-modules node_modules/jest/bin/jest.js --passWithNoTests --silent --colors=false"
gate_step "lint"     "DEFERRED:eslint not in deps yet — A-HR P1 task installs (eslint . --max-warnings=0)"
gate_step "boundary" "DEFERRED:dep-cruiser not installed; install in P1 task with rules forbidding cross-package relative imports and enforcing route→controller→service"
gate_step "security" "gate_default_secret_grep src"

gate_emit

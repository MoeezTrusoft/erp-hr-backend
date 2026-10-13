#!/usr/bin/env bash
# Self-contained CI gate: always run every check, preserving each exit status.
set -uo pipefail
cd "$(dirname "$0")/.."
failed=0
run_check() {
  local name="$1"
  shift
  printf '\n::group::%s\n' "$name"
  if "$@"; then
    printf '%s passed\n' "$name"
  else
    local status=$?
    printf '::error::%s failed (exit %s)\n' "$name" "$status"
    failed=1
  fi
  printf '::endgroup::\n'
}
run_check tests npm test -- --runInBand --silent --colors=false
run_check lint npx --no-install eslint --max-warnings 0
run_check boundaries npx --no-install depcruise src/lib --config .dependency-cruiser.cjs
# The workflow separately runs Gitleaks on the checkout and its history.
exit "$failed"

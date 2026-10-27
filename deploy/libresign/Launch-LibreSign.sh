#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
mkdir -p .runtime
nohup ./Start-LibreSign.sh > .runtime/deploy.log 2>&1 < /dev/null &
printf '%s\n' "$!" > .runtime/deploy.pid
printf '%s\n' 'Deployment process started; inspect .runtime/deploy.log and .runtime/deploy.exit.'

#!/usr/bin/env bash
# scripts/podrun.sh — run a local .mjs script inside a production HR pod.
#
# The image ships /app read-only under uid 10001, so the script is piped to
# /tmp and its `../src/...` imports are rewritten to absolute /app paths.
# Nothing is left behind: /tmp is per-pod and the file is removed after.
#
#   ERP_PROD_PW='...' scripts/podrun.sh scripts/orphan-punch-report.mjs -- --write
#
# Args after `--` are passed through to the script.
# No `set -e`/`pipefail`: every remote call is piped through `grep -v` to strip
# the sudo prompt, and grep exits 1 when it filters everything, which would kill
# the script before it ever ran.
set -uo pipefail

SCRIPT="${1:?usage: podrun.sh <local-script.mjs> [-- args...]}"
shift
[[ "${1:-}" == "--" ]] && shift
ARGS="$*"

HOST="${ERP_PROD_HOST:-erp_trusoft@103.245.195.3}"
PORT="${ERP_PROD_PORT:-2272}"
NS="${ERP_NS:-erp-svc}"
: "${ERP_PROD_PW:?set ERP_PROD_PW}"

# No sudo: k3s.yaml is world-readable, so kubectl works as erp_trusoft. That
# matters — `sudo -S` would read the password from stdin, the same stdin the
# script itself is piped through, and the script would silently never arrive.
ssh_prod() {
  sshpass -p "$ERP_PROD_PW" ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    -p "$PORT" "$HOST" "$1"
}

POD="${ERP_POD:-$(ssh_prod "kubectl get pods -n $NS \
  -l app.kubernetes.io/name=erp-hr-backend --no-headers 2>/dev/null \
  | awk '/Running/{print \$1; exit}'")}"
POD="$(echo "$POD" | tr -d '[:space:]')"
[[ -n "$POD" ]] || { echo "no erp-hr-backend pod found" >&2; exit 1; }
echo "# pod: $POD" >&2

BASE="$(basename "$SCRIPT")"
# ../src/x -> /app/src/x ; ../prisma/x -> /app/prisma/x
# Upload and run are two separate execs on purpose. Doing both in one
# `kubectl exec -i` truncates stdout at exactly 65536 bytes — the script's
# output and the script upload share one pipe. The upload needs -i; the run
# must not have it.
sed -e 's#from "\.\./#from "/app/#g' -e "s#from '\.\./#from '/app/#g" "$SCRIPT" |
  sshpass -p "$ERP_PROD_PW" ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    -p "$PORT" "$HOST" "kubectl exec -i -n $NS $POD -- sh -c 'cat > /tmp/$BASE'"

ssh_prod "kubectl exec -n $NS $POD -- \
  sh -c 'cd /app && node /tmp/$BASE $ARGS; rc=\$?; rm -f /tmp/$BASE; exit \$rc'"

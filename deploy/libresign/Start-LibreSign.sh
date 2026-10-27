#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
case "${1:-}" in
  '') build_args=(--build) ;;
  --use-existing-image) build_args=(--no-build) ;;
  *) printf '%s\n' 'Usage: Start-LibreSign.sh [--use-existing-image]' >&2; exit 2 ;;
esac
command -v docker >/dev/null
[ "$(docker info --format '{{.OSType}}')" = linux ]
mkdir -p .secrets .runtime
chmod 700 .secrets .runtime
exec 9>.runtime/bootstrap.lock
flock -n 9
trap 'result=$?; printf "%s\n" "$result" > .runtime/deploy.exit' EXIT
for name in database_password admin_password integration_password; do
  if [ ! -s ".secrets/$name" ]; then openssl rand -base64 48 > ".secrets/$name"; fi
  chmod 600 ".secrets/$name"
done
chgrp 33 .secrets/integration_password
chmod 640 .secrets/integration_password
compose=(docker compose -f compose.yaml)
if [ -f .runtime/public-https ]; then compose+=(-f compose.production.yaml); fi
if [ -f .runtime/production-mail ]; then compose+=(-f compose.mail.yaml); fi
"${compose[@]}" config --quiet
"${compose[@]}" up -d "${build_args[@]}" --wait --wait-timeout 900
docker compose exec -T --user www-data app sh < bootstrap.sh
if [ ! -s .secrets/integration_app_password ]; then
  docker compose exec -T --user www-data app sh -c 'OC_PASS=$(cat /run/secrets/integration_password); export OC_PASS; php occ user:auth-tokens:add erp-recruitment --password-from-env --name=erp-recruitment' > .runtime/token-output
  python3 - <<'PY'
import pathlib,re
root=pathlib.Path('.')
text=(root/'.runtime/token-output').read_text()
tokens=re.findall(r'(?<![A-Za-z0-9])[A-Za-z0-9]{72}(?![A-Za-z0-9])',text)
if len(tokens)!=1: raise SystemExit('App-password command did not return one token; inspect protected runtime output')
(root/'.secrets/integration_app_password').write_text(tokens[0]+'\n')
(root/'.secrets/integration_app_password').chmod(0o600)
(root/'.runtime/token-output').unlink()
PY
fi
docker compose ps
docker compose port app 80
printf '%s\n' 'LibreSign is ready at the loopback address above. Credential files are in the protected .secrets directory.'

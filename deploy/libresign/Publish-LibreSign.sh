#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
[ "$(id -u)" = 0 ]
mkdir -p .runtime
exec 9>.runtime/publish.lock
flock -n 9
compose=(docker compose -f compose.yaml -f compose.production.yaml)
if [ -f .runtime/production-mail ]; then compose+=(-f compose.mail.yaml); fi
"${compose[@]}" config --quiet
python3 - <<'PY'
import pathlib,shutil,time
config=pathlib.Path('/etc/nginx/sites-available/erp-trusoft.conf')
text=config.read_text()
marker='    include /etc/nginx/snippets/recruitment-libresign.conf;'
needle='    server_name erp.trusoft.ai;'
if text.count(needle)!=2: raise SystemExit('Unexpected ERP nginx structure; inspect before changing it')
if marker not in text:
 backup=pathlib.Path('.runtime/nginx-before-'+str(time.time_ns())+'.conf')
 shutil.copy2(config,backup)
 pathlib.Path('.runtime/nginx-backup-path').write_text(str(backup.resolve()))
 config.write_text(text.replace(needle,needle+'\n'+marker,1))
shutil.copyfile('nginx-location.conf','/etc/nginx/snippets/recruitment-libresign.conf')
PY
if ! nginx -t; then
  if [ -s .runtime/nginx-backup-path ]; then cp -- "$(cat .runtime/nginx-backup-path)" /etc/nginx/sites-available/erp-trusoft.conf; fi
  exit 1
fi
systemctl reload nginx
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
proxy=$(docker network inspect recruitment-libresign_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
[ -n "$proxy" ]
docker compose exec -T --user www-data app php occ config:system:set trusted_proxies 0 --value="$proxy"
docker compose exec -T --user www-data app php occ config:system:set trusted_domains 3 --value=erp.trusoft.ai
curl --fail --silent --show-error --resolve erp.trusoft.ai:443:127.0.0.1 https://erp.trusoft.ai/libresign/status.php
docker compose exec -T --user www-data app php occ libresign:configure:check
printf '\nHTTPS route installed. Verify a synthetic signature before recruitment activation.\n'
touch .runtime/public-https

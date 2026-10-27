#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
[ "$(id -u)" = 0 ]
settings="${1:?Pass a protected JSON file with the Nextcloud mail_* settings}"
mkdir -p .secrets .runtime
exec 9>.runtime/mail-config.lock
flock -n 9
python3 Validate-Mail.py "$settings"
chgrp 33 .secrets/smtp-settings.json
# This loader contains no secrets and must be readable by www-data.
chmod 644 mail.config.php
compose=(docker compose -f compose.yaml)
if [ -f .runtime/public-https ]; then compose+=(-f compose.production.yaml); fi
compose+=(-f compose.mail.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --wait --wait-timeout 180
touch .runtime/production-mail
printf '%s\n' 'Production mail configuration loaded. Verify delivery before enabling recruitment signatures.'

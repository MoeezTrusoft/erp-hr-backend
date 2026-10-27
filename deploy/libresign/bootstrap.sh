#!/bin/sh
set -eu
cd /var/www/html
occ() { php occ --no-interaction "$@"; }
installed=$(occ config:app:get libresign installed_version 2>/dev/null || true)
if [ -n "$installed" ] && [ "$installed" != '15.0.8' ]; then
  echo 'Existing LibreSign version differs; migrate it explicitly before using this bootstrap.' >&2
  exit 1
fi
occ app:enable libresign
occ background:cron
# This dedicated document service must not retain erased PDFs in trash or file versions.
occ app:disable files_trashbin files_versions
# Dedicated signing accounts must not share one company's files with another.
occ config:app:set core shareapi_enabled --value=no
occ config:app:set core shareapi_allow_share_dialog_user_enumeration --value=no
occ config:app:set core shareapi_restrict_user_enumeration_full_match --value=no
occ config:app:set libresign make_validation_url_private --value=true --type=boolean
if ! occ user:info erp-recruitment >/dev/null 2>&1; then
  export OC_PASS=$(cat /run/secrets/integration_password)
  occ user:add --password-from-env --display-name 'ERP Recruitment signing service' erp-recruitment
  unset OC_PASS
fi
# The isolated instance has one non-admin requestor group.
if ! occ group:list --output=json | php -r '$g=json_decode(stream_get_contents(STDIN),true); exit(array_key_exists("recruitment-signers",$g)?0:1);'; then
  occ group:add recruitment-signers
fi
occ group:adduser recruitment-signers erp-recruitment
occ config:app:set libresign groups_request_sign --value='{"allowGroups":["admin","recruitment-signers"],"denyGroups":[]}'
occ config:app:set libresign identify_methods --value='{"can_create_account":false,"factors":[{"name":"email","enabled":true,"requirement":"required","signatureMethods":{"emailToken":{"enabled":true}}}]}'
if [ ! -f config/recruitment-libresign-binaries.ready ]; then
  occ libresign:install --all
  touch config/recruitment-libresign-binaries.ready
fi
if [ ! -f config/recruitment-libresign-ca.ready ]; then
  occ libresign:configure:openssl --cn="${LIBRESIGN_CA_NAME:-Recruitment local development CA}"
  touch config/recruitment-libresign-ca.ready
fi
# This command prints a table but exits zero even when a check reports errors.
# Treat its error rows as a failed bootstrap as well.
report=$(occ libresign:configure:check --no-ansi)
printf '%s\n' "$report"
if printf '%s\n' "$report" | grep -Eiq '(^|[|[:space:]])(error|failed|failure)([|[:space:]]|$)'; then
  exit 1
fi
printf '%s\n' 'LibreSign bootstrap finished. Validate a synthetic signature before enabling offers.'

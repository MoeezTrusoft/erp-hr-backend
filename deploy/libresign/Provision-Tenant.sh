#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
[ "$(id -u)" = 0 ]
tenant="${1:?Pass the verified ERP tenant UUID}"
[[ "$tenant" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
company_name="${2:?Pass the verified company name}"
public_url="${3:-https://erp.trusoft.ai/libresign}"
python3 - "$company_name" "$public_url" <<'PY'
import sys,urllib.parse
name=sys.argv[1]
if not name.strip() or len(name)>160 or any(ord(c)<32 for c in name):
 raise SystemExit('A company name of 1-160 characters without control characters is required')
url=urllib.parse.urlsplit(sys.argv[2])
if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment:
 raise SystemExit('A credential-free HTTPS LibreSign URL is required')
PY
username="erp-recruitment-$tenant"
mkdir -p .secrets .runtime
exec 9>.runtime/tenant-provision.lock
flock -n 9
password=".secrets/$tenant.password"
app_password=".secrets/$tenant.app-password"
if [ ! -s "$password" ]; then openssl rand -base64 48 > "$password"; fi
chmod 600 "$password"
if ! docker compose exec -T --user www-data app php occ user:info "$username" >/dev/null 2>&1; then
  cat "$password" | docker compose exec -T --user www-data app sh -c 'IFS= read -r OC_PASS; export OC_PASS; exec php occ user:add --password-from-env --display-name "$2" "$1"' sh "$username" "$company_name"
fi
# An idempotent rerun also refreshes the verified company name.
docker compose exec -T --user www-data app php occ user:profile "$username" displayname "$company_name"
docker compose exec -T --user www-data app php occ group:adduser recruitment-signers "$username"
if [ ! -s "$app_password" ]; then
  cat "$password" | docker compose exec -T --user www-data app sh -c 'IFS= read -r OC_PASS; export OC_PASS; exec php occ user:auth-tokens:add "$1" --password-from-env --name=erp-recruitment' sh "$username" > .runtime/tenant-token-output
  python3 - "$app_password" <<'PY'
import pathlib,re,sys
source=pathlib.Path('.runtime/tenant-token-output')
tokens=re.findall(r'(?<![A-Za-z0-9])[A-Za-z0-9]{72}(?![A-Za-z0-9])',source.read_text())
if len(tokens)!=1: raise SystemExit('Expected exactly one app password; protected output retained for diagnosis')
pathlib.Path(sys.argv[1]).write_text(tokens[0]+'\n');pathlib.Path(sys.argv[1]).chmod(0o600);source.unlink()
PY
fi
python3 - "$tenant" "$username" "$public_url" <<'PY'
import base64,json,pathlib,re,subprocess,sys,urllib.request
account=json.loads(subprocess.check_output(['docker','compose','exec','-T','--user','www-data','app','php','occ','user:info',sys.argv[2],'--output=json'],text=True))
if 'admin' in account.get('groups',[]) or 'recruitment-signers' not in account.get('groups',[]):
 raise SystemExit('Company requestor must be a non-admin recruitment signer')
secret=pathlib.Path('.secrets/'+sys.argv[1]+'.app-password').read_text().strip()
auth=base64.b64encode((sys.argv[2]+':'+secret).encode()).decode()
address=subprocess.check_output(['docker','compose','port','app','80'],text=True).strip()
if not re.fullmatch(r'127\.0\.0\.1:[0-9]+',address): raise SystemExit('App must bind only to loopback')
request=urllib.request.Request('http://'+address+'/ocs/v2.php/cloud/user?format=json',headers={'Authorization':'Basic '+auth,'OCS-APIRequest':'true'})
with urllib.request.urlopen(request,timeout=20) as response:
 identity=json.load(response)['ocs']
if identity.get('data',{}).get('id') != sys.argv[2]:
 raise SystemExit('Company app password did not authenticate the expected requestor')
path=pathlib.Path('.secrets/hr-libresign.json')
config=json.loads(path.read_text()) if path.exists() else {}
config[sys.argv[1]]={'baseUrl':sys.argv[3].rstrip('/'),'username':sys.argv[2],'appPasswordFile':'/run/secrets/libresign/'+sys.argv[1]+'.app-password'}
temporary=path.with_suffix('.json.tmp')
temporary.write_text(json.dumps(config,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(path)
PY
printf 'Tenant %s provisioned. Mount the protected JSON and tenant app-password files into HR; credentials were not printed.\n' "$tenant"

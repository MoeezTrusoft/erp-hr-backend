#!/usr/bin/env python3
"""Publish protected LibreSign credentials and mount them into the HR workload."""
import argparse, base64, json, os, pathlib, re, subprocess
import importlib.util

def kubectl(*args, input=None):
    result = subprocess.run(['kubectl', *args], input=input, text=True, capture_output=True, check=True, timeout=45)
    return result.stdout

def production_mail_tenants(rows, mail):
    tenants = {r['uuid'] for r in rows}
    if not isinstance(mail,list) or len(mail) != len(rows) or {r['tenantId'] for r in mail} != tenants:
        raise ValueError('Every company needs an explicit mail policy before production binding')
    if any(r.get('mailMode') not in ('SMTP','NO_EMAIL','TEMPORARY') for r in mail):
        raise ValueError('Invalid company mail policy')
    if any(r.get('mailMode') == 'SMTP' and r.get('transportAuthenticated') is not True for r in mail):
        raise ValueError('SMTP authentication must pass before binding')
    eligible = {r['tenantId'] for r in mail if r['mailMode'] == 'SMTP'}
    if not eligible: raise ValueError('No company has production mail configured')
    return eligible

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('registry')
    parser.add_argument('--namespace', default='erp-svc')
    parser.add_argument('--deployment', default='erp-hr-backend')
    parser.add_argument('--container', default='hr')
    parser.add_argument('--apply-mount', action='store_true')
    parser.add_argument('--instances-root', help='Root containing one managed installation directory per company UUID')
    parser.add_argument('--production-mail-only', action='store_true', help='Bind only companies with authenticated SMTP; exclude explicit NO_EMAIL and TEMPORARY entries')
    args = parser.parse_args()
    if os.geteuid() != 0: raise SystemExit('Run as root')
    if not all(re.fullmatch(r'[a-z0-9][a-z0-9.-]*', value) for value in [args.namespace,args.deployment,args.container]):
        raise SystemExit('Invalid Kubernetes object name')
    os.umask(0o077)
    root = pathlib.Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('company_registry',root/'Provision-Companies.py')
    registry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry)
    rows = registry.companies_from(args.registry)
    instances = pathlib.Path(args.instances_root).resolve() if args.instances_root else None
    all_config = {} if instances else json.loads((root/'.secrets/hr-libresign.json').read_text())
    public_urls = set()
    if instances:
        verified = json.loads((instances/'.runtime/verification.json').read_text())
        approved = {r['tenantId']:r for r in verified if r.get('httpsHealthy') and r.get('companyAccountAuthenticated') and r.get('foreignAccountDenied') and r.get('syntheticSigningAndErasure') and r.get('cryptographicSignatureValid')}
        if set(approved) != {r['uuid'] for r in rows}:
            raise SystemExit('Verify every separate company installation before binding HR')
    eligible = {r['uuid'] for r in rows}
    if args.production_mail_only:
        if not instances: raise SystemExit('Production mail selection requires separate instances')
        mail = json.loads((instances/'.runtime/company-mail.json').read_text())
        eligible = production_mail_tenants(rows, mail)
    config = {}
    data = {}
    for row in rows:
        tenant = row['uuid']
        if tenant not in eligible: continue
        company_root = instances/tenant if instances else root
        if instances:
            if company_root.resolve().parent != instances: raise SystemExit('Company directory escapes managed root')
            manifest = json.loads((company_root/'.runtime/instance.json').read_text())
            company_config = json.loads((company_root/'.secrets/hr-libresign.json').read_text())
            if manifest['tenantId'] != tenant or set(company_config) != {tenant}:
                raise SystemExit('Separate installation has unexpected company ownership')
            entry = company_config[tenant]
            if entry['baseUrl'] != manifest['baseUrl'] or entry['baseUrl'] != approved[tenant]['baseUrl'] or entry['baseUrl'] in public_urls:
                raise SystemExit('Company installations must have distinct, verified URLs')
            public_urls.add(entry['baseUrl'])
        else:
            entry = all_config[tenant]
        expected = '/run/secrets/libresign/'+tenant+'.app-password'
        if entry['username'] != 'erp-recruitment-'+tenant or entry['appPasswordFile'] != expected or not entry['baseUrl'].startswith('https://'):
            raise SystemExit('Unexpected company configuration')
        config[tenant] = entry
        path = company_root/'.secrets'/(tenant+'.app-password')
        if path.stat().st_mode & 0o077: raise SystemExit('Company secret has unsafe permissions')
        data[path.name] = base64.b64encode(path.read_bytes()).decode()
    data['hr-libresign.json'] = base64.b64encode((json.dumps(config,indent=2)+'\n').encode()).decode()
    name = 'erp-hr-recruitment-libresign'
    manager = 'recruitment-libresign'
    current = kubectl('-n',args.namespace,'get','secret',name,'--ignore-not-found','-o','json').strip()
    if current and json.loads(current).get('metadata',{}).get('labels',{}).get('app.kubernetes.io/managed-by') != manager:
        raise SystemExit('Existing secret is managed elsewhere; refusing to overwrite')
    deployment = json.loads(kubectl('-n',args.namespace,'get','deployment',args.deployment,'-o','json'))
    pod = deployment['spec']['template']['spec']
    if args.container not in {c['name'] for c in pod['containers']}:
        raise SystemExit('HR container not found')
    if not pod.get('securityContext',{}).get('fsGroup'):
        raise SystemExit('HR pod needs an fsGroup to read a group-readable secret')
    secret = {'apiVersion':'v1','kind':'Secret','metadata':{'name':name,'namespace':args.namespace,'labels':{'app.kubernetes.io/managed-by':manager}},'type':'Opaque','data':data}
    kubectl('apply','--server-side','--field-manager='+manager,'-f','-',input=json.dumps(secret))
    patch = {'spec':{'template':{'spec':{'volumes':[{'name':'recruitment-libresign','secret':{'secretName':name,'defaultMode':288}}],'containers':[{'name':args.container,'env':[{'name':'HR_LIBRESIGN_CONFIG_FILE','value':'/run/secrets/libresign/hr-libresign.json'}],'volumeMounts':[{'name':'recruitment-libresign','mountPath':'/run/secrets/libresign','readOnly':True}]}]}}}}
    patch_path = root/'.runtime/hr-libresign-binding.patch.json'
    patch_path.write_text(json.dumps(patch,indent=2)+'\n')
    if args.apply_mount:
        kubectl('-n',args.namespace,'patch','deployment',args.deployment,'--type=strategic','--patch-file',str(patch_path))
    print(json.dumps({'companies':len(config),'excludedCompanies':len(rows)-len(config),'secret':name,'namespace':args.namespace,'mounted':args.apply_mount,'signingFeatureEnabledByThisScript':False}))

if __name__ == '__main__':
    try: main()
    except subprocess.CalledProcessError as error:
        raise SystemExit('Kubernetes operation failed with exit code '+str(error.returncode)) from None

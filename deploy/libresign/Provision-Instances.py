#!/usr/bin/env python3
"""Create a separate LibreSign stack for every verified active ERP company."""
import argparse, importlib.util, json, os, pathlib, re, shutil, socket, subprocess

SOURCE = pathlib.Path(__file__).resolve().parent
FILES = ['compose.yaml', 'compose.production.yaml', 'compose.mail.yaml', 'Dockerfile', '.dockerignore',
         'bootstrap.sh', 'Start-LibreSign.sh', 'Provision-Tenant.sh', 'Configure-Mail.sh',
         'mail.config.php', 'Validate-Mail.py', 'Smoke-LibreSign.mjs', 'versions.json']

def registry_from(path):
    spec = importlib.util.spec_from_file_location('registry', SOURCE/'Provision-Companies.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.companies_from(path)

def run(args, cwd, **kwargs):
    return subprocess.run(args, cwd=cwd, check=True, text=True, timeout=kwargs.pop('timeout', 120), **kwargs)

def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value, indent=2)+'\n')
    temporary.chmod(0o600)
    temporary.replace(path)

def port_available(port):
    with socket.socket() as connection:
        try: connection.bind(('127.0.0.1', port))
        except OSError: return False
    return True

def plan_instances(rows, host, first_port=5400):
    if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', host):
        raise ValueError('Invalid HTTPS hostname')
    if first_port < 1024 or first_port+2*len(rows) > 65535:
        raise ValueError('Invalid loopback port range')
    return [{'tenantId':row['uuid'], 'companyName':row['name'],
             'project':'recruitment-sign-'+row['uuid'], 'httpPort':first_port+index*2,
             'mailpitPort':first_port+index*2+1, 'host':host,
             'webroot':'/signing/'+row['uuid'], 'baseUrl':'https://'+host+'/signing/'+row['uuid']}
            for index,row in enumerate(rows)]

def prepare(source, root, plan):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    for entry in plan:
        folder=root/entry['tenantId']
        manifest=folder/'.runtime/instance.json'
        if folder.exists() and not manifest.is_file():
            raise ValueError('Refusing an existing directory without managed instance metadata')
        if manifest.exists() and json.loads(manifest.read_text()) != entry:
            raise ValueError('Instance identity, name, ports or URL changed; migrate explicitly')
        if not manifest.exists() and not all(port_available(entry[key]) for key in ['httpPort','mailpitPort']):
            raise ValueError('A requested company loopback port is already occupied')
    for entry in plan:
        folder=root/entry['tenantId']
        folder.mkdir(mode=0o700, exist_ok=True)
        (folder/'.runtime').mkdir(mode=0o700, exist_ok=True)
        for file in FILES:
            shutil.copyfile(source/file, folder/file)
            (folder/file).chmod(0o700 if file.endswith('.sh') else 0o644)
        # Synthetic assets contain no customer documents or credentials.
        for file in ['synthetic-offer.pdf']:
            shutil.copyfile(source/'.runtime'/file, folder/'.runtime'/file)
        shutil.copyfile(source/'libresignClient.mjs', folder/'libresignClient.mjs')
        environment = {
            'LIBRESIGN_PROJECT_NAME':entry['project'], 'LIBRESIGN_HTTP_PORT':entry['httpPort'],
            'LIBRESIGN_MAILPIT_PORT':entry['mailpitPort'], 'LIBRESIGN_PUBLIC_HOST':entry['host'],
            'LIBRESIGN_WEBROOT':entry['webroot'], 'LIBRESIGN_CA_NAME':entry['companyName']+' Recruitment Signing CA',
        }
        (folder/'.env').write_text(''.join(key+'='+json.dumps(str(value).replace('$','$$'))+'\n' for key,value in environment.items()))
        (folder/'.env').chmod(0o600)
        (folder/'.runtime/public-https').touch(mode=0o600)
        atomic_json(folder/'.runtime/instance.json', entry)
    atomic_json(root/'instances.json', plan)

def publish(root, plan):
    hosts={entry['host'] for entry in plan}
    if len(hosts)!=1: raise ValueError('This publisher requires one existing TLS host')
    host=next(iter(hosts))
    config=pathlib.Path('/etc/nginx/sites-available/erp-trusoft.conf')
    snippet=pathlib.Path('/etc/nginx/snippets/recruitment-libresign-companies.conf')
    marker='    include '+str(snippet)+';'
    text=config.read_text()
    needle='    server_name '+host+';'
    if text.count(needle)!=2: raise ValueError('Unexpected ERP nginx structure; inspect it before publishing')
    content=''
    for entry in plan:
        path=entry['webroot']
        content += ('location = '+path+' { return 308 '+path+'/; }\n'
                    'location ^~ '+path+'/ {\n'
                    '    proxy_pass http://127.0.0.1:'+str(entry['httpPort'])+'/;\n'
                    '    proxy_http_version 1.1;\n'
                    '    proxy_set_header Host '+host+';\n'
                    '    proxy_set_header X-Forwarded-Host '+host+';\n'
                    '    proxy_set_header X-Forwarded-Proto https;\n'
                    '    proxy_set_header X-Forwarded-For $remote_addr;\n'
                    '    proxy_set_header X-Real-IP $remote_addr;\n'
                    '    proxy_read_timeout 120s;\n    proxy_send_timeout 120s;\n'
                    '    client_max_body_size 20m;\n    add_header Referrer-Policy no-referrer always;\n}\n')
    previous_snippet=snippet.read_text() if snippet.exists() else None
    backup=root/'.runtime'
    backup.mkdir(mode=0o700, exist_ok=True)
    (backup/'nginx-before.conf').write_text(text)
    if previous_snippet is not None: (backup/'nginx-snippet-before.conf').write_text(previous_snippet)
    try:
        snippet.write_text(content)
        snippet.chmod(0o644)
        if marker not in text: config.write_text(text.replace(needle,needle+'\n'+marker,1))
        run(['nginx','-t'],root)
        run(['systemctl','reload','nginx'],root)
    except BaseException:
        config.write_text(text)
        if previous_snippet is None: snippet.unlink(missing_ok=True)
        else: snippet.write_text(previous_snippet)
        run(['nginx','-t'],root)
        run(['systemctl','reload','nginx'],root)
        raise
    for entry in plan:
        run(['curl','--fail','--silent','--show-error','--max-time','20','--resolve',host+':443:127.0.0.1',entry['baseUrl']+'/status.php'],root)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('registry')
    parser.add_argument('--root',required=True)
    parser.add_argument('--host',default='erp.trusoft.ai')
    parser.add_argument('--first-port',type=int,default=5400)
    parser.add_argument('--prepare-only',action='store_true')
    args=parser.parse_args()
    if os.geteuid()!=0: raise SystemExit('Run as root to protect company credentials')
    os.umask(0o077)
    if not pathlib.Path(args.root).is_absolute(): raise ValueError('Use an absolute installation root')
    root=pathlib.Path(args.root).resolve()
    if root==SOURCE or SOURCE in root.parents or root in SOURCE.parents or not root.is_absolute():
        raise ValueError('Company installations require a separate absolute root')
    rows=registry_from(args.registry)
    plan=plan_instances(rows,args.host,args.first_port)
    prepare(SOURCE,root,plan)
    if args.prepare_only: return
    for entry in plan:
        folder=root/entry['tenantId']
        print('Provisioning separate installation for '+entry['companyName'],flush=True)
        run(['bash','Start-LibreSign.sh','--use-existing-image'],folder,timeout=1800)
        gateway=run(['docker','network','inspect',entry['project']+'_default','--format','{{range .IPAM.Config}}{{.Gateway}}{{end}}'],folder,capture_output=True).stdout.strip()
        run(['docker','compose','exec','-T','--user','www-data','app','php','occ','config:system:set','trusted_proxies','0','--value='+gateway],folder)
        run(['bash','Provision-Tenant.sh',entry['tenantId'],entry['companyName'],entry['baseUrl']],folder,timeout=240)
    publish(root,plan)
    print('All separate company installations are healthy. Verify synthetic signatures and configure company SMTP before activation.',flush=True)

if __name__=='__main__':
    try: main()
    except subprocess.CalledProcessError as error:
        raise SystemExit('Company deployment step failed with exit code '+str(error.returncode)) from None

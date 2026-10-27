#!/usr/bin/env python3
"""Verify independent company installations using synthetic Mailpit-only signatures."""
import argparse, base64, hashlib, json, os, pathlib, subprocess, urllib.error, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def fetch(url, credentials=None):
    headers={'Accept':'application/json','OCS-APIRequest':'true'}
    if credentials: headers['Authorization']='Basic '+base64.b64encode(credentials.encode()).decode()
    request=urllib.request.Request(url,headers=headers)
    with urllib.request.build_opener(NoRedirect).open(request,timeout=25) as response:
        return json.load(response)

def command(folder,*args):
    result=subprocess.run(args,cwd=folder,text=True,capture_output=True,timeout=300)
    with (folder/'.runtime/verification.log').open('a') as log:
        log.write(result.stdout+result.stderr)
    if result.returncode: raise RuntimeError('Synthetic verification command failed; inspect protected instance log')
    return result.stdout

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True)
    args=parser.parse_args()
    if os.geteuid()!=0: raise SystemExit('Run as root')
    os.umask(0o077)
    root=pathlib.Path(args.root).resolve()
    plan=json.loads((root/'instances.json').read_text())
    instance_ids=set(); volumes=set(); report=[]
    for index,entry in enumerate(plan):
        tenant=entry['tenantId']; folder=root/tenant
        if folder.resolve().parent!=root or json.loads((folder/'.runtime/instance.json').read_text())!=entry:
            raise ValueError('Company installation identity mismatch')
        status=fetch(entry['baseUrl']+'/status.php')
        if not status.get('installed') or status.get('maintenance') or status.get('needsDbUpgrade'):
            raise RuntimeError('Company installation is not healthy')
        instance_id=command(folder,'docker','compose','exec','-T','--user','www-data','app','php','occ','config:system:get','instanceid').strip()
        if not instance_id or instance_id in instance_ids: raise RuntimeError('Company Nextcloud instance IDs must differ')
        instance_ids.add(instance_id)
        container=command(folder,'docker','compose','ps','-q','app').strip()
        mounts=json.loads(command(folder,'docker','inspect',container))[0]['Mounts']
        data_volume=next(m['Name'] for m in mounts if m['Destination']=='/var/www/html')
        if data_volume in volumes: raise RuntimeError('Company storage volumes must differ')
        volumes.add(data_volume)
        password=(folder/'.secrets'/(tenant+'.app-password')).read_text().strip()
        identity=fetch(entry['baseUrl']+'/ocs/v2.php/cloud/user?format=json','erp-recruitment-'+tenant+':'+password)
        if identity.get('ocs',{}).get('data',{}).get('id')!='erp-recruitment-'+tenant:
            raise RuntimeError('Company requestor authentication failed')
        foreign=plan[(index+1)%len(plan)]['tenantId']
        if foreign!=tenant:
            other_password=(root/foreign/'.secrets'/(foreign+'.app-password')).read_text().strip()
            try: foreign_identity=fetch(entry['baseUrl']+'/ocs/v2.php/cloud/user?format=json','erp-recruitment-'+foreign+':'+other_password)
            except urllib.error.HTTPError as error:
                if error.code not in [401,403,404]: raise
            else:
                if foreign_identity.get('ocs',{}).get('data',{}).get('id'):
                    raise RuntimeError('Another company account authenticated on this installation')
        env={**os.environ,'LIBRESIGN_SMOKE_TENANT':tenant}
        smoke=subprocess.run(['node','Smoke-LibreSign.mjs'],cwd=folder,env=env,text=True,capture_output=True,timeout=360)
        with (folder/'.runtime/verification.log').open('a') as log: log.write(smoke.stdout+smoke.stderr)
        if smoke.returncode: raise RuntimeError('Company synthetic signature verification failed')
        command(folder,'docker','compose','cp','.runtime/synthetic-signed.pdf','app:/tmp/recruitment-synthetic-signed.pdf')
        pdfsig=command(folder,'docker','compose','exec','-T','app','timeout','20','pdfsig','-nocert','/tmp/recruitment-synthetic-signed.pdf')
        if 'Signature is Valid' not in pdfsig or 'Total document signed' not in pdfsig:
            raise RuntimeError('Cryptographic verification of the complete synthetic PDF failed')
        report.append({'tenantId':tenant,'companyName':entry['companyName'],'baseUrl':entry['baseUrl'],
                       'httpsHealthy':True,'companyAccountAuthenticated':True,'foreignAccountDenied':True,
                       'syntheticSigningAndErasure':True,'cryptographicSignatureValid':True,
                       'signedPdfSha256':hashlib.sha256((folder/'.runtime/synthetic-signed.pdf').read_bytes()).hexdigest(),
                       'productionMailConfigured':(folder/'.runtime/production-mail').exists()})
        temporary=root/'.runtime/verification.json.tmp'
        temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.chmod(0o600)
        temporary.replace(root/'.runtime/verification.json')
        print('Verified independent installation and synthetic signature: '+entry['companyName'],flush=True)
    print('Verified companies: '+str(len(report)),flush=True)

if __name__=='__main__': main()

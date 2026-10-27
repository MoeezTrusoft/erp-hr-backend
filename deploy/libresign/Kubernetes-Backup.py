#!/usr/bin/env python3
"""Consistent, encrypted, per-company LibreSign recovery capture. Docker is untouched."""
import argparse
from KubernetesBackupSignals import install_signal_handlers
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

COMPANIES = {
 'trusoft':'40314ef4-0a81-4390-b631-b3ad3f21f523',
 'boc':'14d8c7b1-194d-4e35-b058-b9cb9aa9fba2',
 'homevision':'61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
 'homenet':'8ff0533b-62f6-4be9-a78e-69adf49e00bc',
 'joc':'8f4a526f-d45b-4da2-b772-d6682e849812',
}
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')
DATA=Path('/var/lib/erp-recruitment-signing')
SOURCE=Path('/home/erp_trusoft/recruitment-libresign-companies')
TOOLS=Path(__file__).resolve().parent

def run(args, **kwargs):
 return subprocess.run(args,check=True,**kwargs)

def kube(ns,*args):
 return run(['kubectl','-n',ns,*args],capture_output=True,text=True).stdout

def save(path,value):
 with path.open('w') as f: json.dump(value,f,indent=2)
 os.chmod(path,0o600)

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while data:=f.read(1024*1024):h.update(data)
 return h.hexdigest()

def maintenance(ns,enabled):
 kube(ns,'exec','deploy/app','-c','app','--','su','-s','/bin/sh','www-data','-c','php occ maintenance:mode '+('--on' if enabled else '--off'))

def scale(ns,name,count):
 kube(ns,'scale','deploy/'+name,'--replicas='+str(count))
 if count:
  kube(ns,'rollout','status','deploy/'+name,'--timeout=180s')
 else:
  for _ in range(90):
   pods=json.loads(kube(ns,'get','pod','-l','app='+name,'-o','json'))['items']
   if not pods:return
   time.sleep(2)
  raise RuntimeError('Deployment did not drain: '+name)

def capture(name):
 if os.geteuid()!=0:raise RuntimeError('Root required for protected recovery capture')
 os.umask(0o077)
 for unit in ('docker.service','docker.socket'):
  p=subprocess.run(['systemctl','is-active',unit],capture_output=True,text=True)
  if p.stdout.strip() in ('active','activating'):raise RuntimeError('Docker must remain stopped')
 cid=COMPANIES[name];ns='sign-'+name;run_id=str(uuid.uuid4())
 dest=ROOT/cid/run_id;dest.mkdir(parents=True,mode=0o700)
 stage=dest/'staging';meta=stage/'metadata';meta.mkdir(parents=True,mode=0o700)
 workloads=json.loads(kube(ns,'get','deploy','app','cron','-o','json'))['items']
 replicas={x['metadata']['name']:x['spec'].get('replicas',1) for x in workloads}
 if replicas!={'app':1,'cron':1}:raise RuntimeError('Expected healthy single app and cron before capture')
 evidence={'version':1,'companyId':cid,'company':name,'runId':run_id,'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'state':'CAPTURING','replicas':replicas}
 save(dest/'capture-state.json',evidence)
 paused=False
 try:
  paused=True;scale(ns,'cron',0)
  maintenance(ns,True)
  scale(ns,'app',0)
  (meta/'runtime-secret.json').write_text(kube(ns,'get','secret','runtime','-o','json'))
  (meta/'workloads.json').write_text(kube(ns,'get','deploy,svc,networkpolicy,pvc','-o','json'))
  shutil.copy2('/opt/erp-cicd/recruitment-signing-k8s/companies/'+cid+'/manifest.json',meta/'recovery-manifest.json')
  credential=SOURCE/cid/'.secrets'/(cid+'.app-password')
  if not credential.is_file():raise RuntimeError('Company-specific HR app credential missing')
  shutil.copy2(credential,meta/'hr-app-password')
  with (meta/'database.dump').open('wb') as out:
   run(['kubectl','-n',ns,'exec','deploy/db','--','pg_dump','-U','libresign','-d','libresign','-Fc'],stdout=out)
  with (meta/'database-roles.sql').open('wb') as out:
   run(['kubectl','-n',ns,'exec','deploy/db','--','pg_dumpall','-U','libresign','--roles-only'],stdout=out)
  evidence['databaseSha256']=digest(meta/'database.dump')
  evidence['images']={x['metadata']['name']:x['spec']['template']['spec']['containers'][0]['image'] for x in json.loads(kube(ns,'get','deploy','-o','json'))['items']}
  save(meta/'manifest.json',evidence)
  archive=dest/'snapshot.tar.gz'
  run(['tar','--acls','--xattrs','--numeric-owner','-I','gzip -1','-cf',str(archive),'-C',str(DATA/cid),'nextcloud','-C',str(stage),'metadata'])
  evidence['archiveSha256']=digest(archive)
  evidence['archiveBytes']=archive.stat().st_size
 finally:
  if paused:
   scale(ns,'app',replicas['app'])
   maintenance(ns,False)
   scale(ns,'cron',replicas['cron'])
   evidence['servicesResumedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
   save(dest/'capture-state.json',evidence)
 key=dest/'recovery.key';key.write_bytes(os.urandom(32));os.chmod(key,0o600)
 encrypted=dest/'snapshot.aesgcm'
 run(['node',str(TOOLS/'Backup-Crypto.mjs'),'encrypt',str(archive),str(encrypted),str(key)])
 # Authentication and byte comparison are checked before deleting plaintext.
 verify=dest/'verify.tar.gz'
 run(['node',str(TOOLS/'Backup-Crypto.mjs'),'decrypt',str(encrypted),str(verify),str(key)])
 if digest(verify)!=evidence['archiveSha256']:raise RuntimeError('Encrypted recovery round-trip mismatch')
 verify.unlink();archive.unlink();shutil.rmtree(stage)
 evidence['encryptedSha256']=digest(encrypted)
 evidence['parts']=[]
 with encrypted.open('rb') as src:
  index=0
  while chunk:=src.read(64*1024*1024):
   part=dest/('part-'+str(index).zfill(4)+'.bin');part.write_bytes(chunk)
   evidence['parts'].append({'filename':part.name,'size':len(chunk),'sha256':hashlib.sha256(chunk).hexdigest()});index+=1
 evidence['state']='ENCRYPTED_LOCAL_VERIFIED';evidence['keySha256']=digest(key)
 save(dest/'capture-state.json',evidence)
 print(json.dumps({'company':name,'runId':run_id,'path':str(dest),'state':evidence['state'],'parts':len(evidence['parts']),'archiveBytes':evidence['archiveBytes']}),flush=True)

if __name__=='__main__':
 install_signal_handlers()
 p=argparse.ArgumentParser();p.add_argument('--company',choices=COMPANIES,required=True)
 capture(p.parse_args().company)

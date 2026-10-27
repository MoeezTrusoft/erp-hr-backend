#!/usr/bin/env python3
"""Capture, upload and independently restore five company installations sequentially."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
from KubernetesBackupLock import backup_run_lock
from KubernetesBackupSignals import install_signal_handlers, check_stop
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups');TOOLS=Path(__file__).resolve().parent
NAMES=['trusoft','boc','homevision','homenet','joc']
def call(file,*args):
 check_stop()
 try:p=subprocess.run(['python3',str(TOOLS/file),*map(str,args)],check=True,capture_output=True,text=True)
 except subprocess.CalledProcessError as error:
  check_stop()
  f=ROOT/('last-'+file+'.error.log');f.write_text(error.stderr or 'No diagnostic');os.chmod(f,0o600);raise
 for line in p.stdout.splitlines():print(line,flush=True)
 return json.loads(p.stdout.strip().splitlines()[-1])
def save(path,obj):
 tmp=path.with_suffix('.partial');tmp.write_text(json.dumps(obj,indent=2));os.chmod(tmp,0o600);os.replace(tmp,path)
def retry(file,*args):
 for attempt in range(3):
  try:return call(file,*args)
  except subprocess.CalledProcessError:
   if attempt==2:raise
   print(json.dumps({'retry':file,'attempt':attempt+1}),flush=True);time.sleep(5)
def main(index):
 os.umask(0o077);ROOT.mkdir(exist_ok=True,mode=0o700)
 data=json.loads(index.read_text()) if index.exists() else {'runId':str(uuid.uuid4()),'companies':{}}
 save(index,data)
 for name in NAMES:
  item=data['companies'].setdefault(name,{})
  if not item.get('capture'):
   item['capture']=call('Kubernetes-Backup.py','--company',name)['path'];save(index,data)
  path=Path(item['capture'])
  if not item.get('uploaded'):
   item['uploaded']=retry('Kubernetes-DamBackup.py','upload',path);save(index,data)
  if not item.get('restored'):
   if not item.get('restorePath'):
    restored=retry('Kubernetes-DamBackup.py','restore',path);item['restorePath']=restored['restorePath'];save(index,data)
   item['restored']=call('Kubernetes-RestoreProbe.py',item['restorePath']);save(index,data)
 data['state']='FIVE_COMPANY_DAM_RESTORE_VERIFIED';data['completedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save(index,data);print(json.dumps({'state':data['state'],'index':str(index)}),flush=True)
if __name__=='__main__':
 install_signal_handlers(defer=True)
 p=argparse.ArgumentParser();p.add_argument('--index',type=Path,required=True);p.add_argument('--lock-held',action='store_true');a=p.parse_args();i=a.index.resolve()
 if i.parent!=ROOT:raise RuntimeError('Index must be in the protected backup root')
 ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
 if a.lock_held:main(i)
 else:
  with backup_run_lock(ROOT):main(i)

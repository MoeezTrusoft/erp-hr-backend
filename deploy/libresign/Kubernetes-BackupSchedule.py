#!/usr/bin/env python3
"""Daily DAM backup dispatch and operator-readable freshness status; no retention deletion."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from KubernetesBackupLock import backup_run_lock
from KubernetesBackupSignals import install_signal_handlers, check_stop
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')
TOOLS=Path(__file__).resolve().parent
COMPLETE='FIVE_COMPANY_DAM_RESTORE_VERIFIED'
NAMES={'trusoft','boc','homevision','homenet','joc'}

def stamp(): return datetime.now(timezone.utc).isoformat()
def save(path,value):
 temporary=path.with_suffix('.partial');temporary.write_text(json.dumps(value,indent=2));os.chmod(temporary,0o600);os.replace(temporary,path)
def state():
 files=[p for p in ROOT.glob('*.json') if p.name!='latest-dam-backup.json']
 completed=[];pending=[]
 for path in files:
  try: value=json.loads(path.read_text())
  except (ValueError,OSError): continue
  if not isinstance(value.get('companies'),dict): continue
  if value.get('state')==COMPLETE and set(value['companies'])==NAMES and all(v.get('restored',{}).get('state')=='DAM_DATABASE_APPLICATION_RESTORE_PASS' for v in value['companies'].values()):completed.append(path)
  elif path.name.startswith('scheduled-'):pending.append(path)
 last=max(completed,key=lambda p:p.stat().st_mtime) if completed else None
 age=(datetime.now(timezone.utc).timestamp()-last.stat().st_mtime)/3600 if last else None
 free=shutil.disk_usage(ROOT).free
 return {'checkedAt':stamp(),'latestIndex':str(last) if last else None,'ageHours':round(age,2) if age is not None else None,'fresh':age is not None and age<=36,'freeBytes':free,'spaceAvailable':free>=30*1024**3},pending

def main(check=False):
 if os.geteuid()!=0:raise RuntimeError('Protected backup operator identity required')
 os.umask(0o077);ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
 if check:
  result,_=state();print(json.dumps(result));return 0 if result['fresh'] and result['spaceAvailable'] else 1
 with backup_run_lock(ROOT):
  status,pending=state()
  if not status['spaceAvailable']:raise RuntimeError('Backup needs at least 30 GiB free; prior DAM backups are retained')
  if not pending and status['fresh'] and status['ageHours']<20:
   recent={'state':'RECENT_VERIFIED_BACKUP','checkedAt':stamp(),'index':status['latestIndex'],'ageHours':status['ageHours']}
   save(ROOT/'latest-dam-backup.json',recent);print(json.dumps(recent),flush=True);return 0
  # Interrupted runs resume the same durable capture/upload/restore receipts.
  index=min(pending,key=lambda p:p.stat().st_mtime) if pending else ROOT/('scheduled-'+datetime.now(timezone.utc).strftime('%Y%m%d')+'.json')
  save(ROOT/'latest-dam-backup.json',{'state':'RUNNING','startedAt':stamp(),'index':str(index)})
  check_stop()
  result=subprocess.run([sys.executable,str(TOOLS/'Kubernetes-BackupAll.py'),'--index',str(index),'--lock-held'],check=False)
  final={'state':'PASS' if result.returncode==0 else 'FAILED','finishedAt':stamp(),'index':str(index),'exitCode':result.returncode}
  save(ROOT/'latest-dam-backup.json',final);print(json.dumps(final),flush=True);return result.returncode
if __name__=='__main__':
 install_signal_handlers(defer=True)
 p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');a=p.parse_args();sys.exit(main(a.check))

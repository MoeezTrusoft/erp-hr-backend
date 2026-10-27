#!/usr/bin/env python3
"""Transfer encrypted LibreSign snapshots through DAM, then restore DAM bytes locally."""
import argparse
from KubernetesBackupSignals import install_signal_handlers
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')
TOOLS=Path(__file__).resolve().parent
POD='/tmp/recruitment-dam-backup'
BASE=['kubectl','-n','erp-svc','exec','-i','deploy/erp-hr-backend','-c','hr','--']

def kube(args,**kwargs):return subprocess.run(BASE+args,check=True,**kwargs)
def save(path,value):
 tmp=path.with_suffix('.partial');tmp.write_text(json.dumps(value,indent=2));os.chmod(tmp,0o600);os.replace(tmp,path)
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def send(path,target):
 with path.open('rb') as f:kube(['sh','-c','umask 077; cat > '+target],stdin=f,capture_output=True)
def receive(source,path):
 with path.open('wb') as f:kube(['cat',source],stdout=f)
 os.chmod(path,0o600)
def setup():
 kube(['sh','-c','umask 077; mkdir -p '+POD],capture_output=True)
 send(TOOLS/'Dam-Backup-Transfer.mjs',POD+'/transfer.mjs')
 send(TOOLS/'Dam-Upload-Recovery.mjs',POD+'/Dam-Upload-Recovery.mjs')
def invoke(action,req,dest):
 rp=dest/'transfer-request.json';save(rp,req);send(rp,POD+'/request.json')
 try:p=kube(['node',POD+'/transfer.mjs',action,POD+'/request.json'],capture_output=True,text=True)
 except subprocess.CalledProcessError as error:
  (dest/'transfer-error.log').write_text(error.stderr or 'Transfer failed without diagnostic output');os.chmod(dest/'transfer-error.log',0o600)
  raise RuntimeError('DAM transfer failed; protected diagnostic: '+str(dest/'transfer-error.log')) from None
 try:return json.loads(p.stdout.strip())
 except ValueError:raise RuntimeError('Unexpected DAM transfer response') from None

def upload(path):
 state=json.loads((path/'capture-state.json').read_text());cid=state['companyId'];rid=state['runId']
 if state['state'] not in ('ENCRYPTED_LOCAL_VERIFIED','DAM_VERIFIED'):raise RuntimeError('Capture is incomplete')
 receipt_path=path/'dam-receipt.json'
 receipt=json.loads(receipt_path.read_text()) if receipt_path.exists() else {'version':1,'companyId':cid,'runId':rid,'parts':[]}
 parent='hr-signing-backup:'+cid+':'+rid
 def one(file,parent_id,expected):
  if digest(file)!=expected:raise RuntimeError('Local recovery part changed')
  pending=path/('pending-'+file.name+'.json')
  completing=path/('completing-'+file.name+'.json')
  if pending.exists():
   req=json.loads(pending.read_text())
   if req['companyId']!=cid or req['parentId']!=parent_id or req['sha256']!=expected:raise RuntimeError('Pending receipt scope mismatch')
   result=invoke('verify',req,path);pending.unlink();completing.unlink(missing_ok=True);return result
  checkpoint=json.loads(completing.read_text()) if completing.exists() else None
  kube(['rm','-f',POD+'/uploaded.json',POD+'/completing.json'],capture_output=True)
  send(file,POD+'/part.bin')
  try:result=invoke('upload',{'companyId':cid,'parentId':parent_id,'input':POD+'/part.bin','filename':'libresign-'+rid+'-'+file.name,'sha256':expected,'completion':checkpoint},path)
  except RuntimeError:
   try:receive(POD+'/uploaded.json',pending)
   except subprocess.CalledProcessError:pending.unlink(missing_ok=True)
   try:receive(POD+'/completing.json',completing)
   except subprocess.CalledProcessError:
    if checkpoint is None:completing.unlink(missing_ok=True)
   raise
  completing.unlink(missing_ok=True)
  kube(['rm','-f',POD+'/part.bin'],capture_output=True)
  return result
 if 'key' not in receipt:
  receipt['key']=one(path/'recovery.key','hr-signing-recovery-key:'+cid+':'+rid,state['keySha256']);save(receipt_path,receipt)
 for index,part in enumerate(state['parts']):
  if index<len(receipt['parts']):
   if receipt['parts'][index]['sha256']!=part['sha256']:raise RuntimeError('Receipt mismatch')
   continue
  receipt['parts'].append(one(path/part['filename'],parent,part['sha256']));save(receipt_path,receipt)
  print(json.dumps({'companyId':cid,'part':index,'verified':True}),flush=True)
 receipt['archiveSha256']=state['archiveSha256'];receipt['encryptedSha256']=state['encryptedSha256'];receipt['databaseSha256']=state['databaseSha256'];receipt['images']=state['images'];receipt['startedAt']=state['startedAt']
 if 'manifest' not in receipt:
  manifest=path/'recovery-manifest.bin';save(manifest,receipt)
  receipt['manifest']=one(manifest,parent,digest(manifest));save(receipt_path,receipt)
 state['state']='DAM_VERIFIED';save(path/'capture-state.json',state)
 print(json.dumps({'companyId':cid,'state':'DAM_VERIFIED','manifestAssetId':receipt['manifest']['assetId'],'parts':len(receipt['parts'])}),flush=True)

def restore(path):
 receipt=json.loads((path/'dam-receipt.json').read_text());dest=path/('restore-'+str(uuid.uuid4()));dest.mkdir(mode=0o700)
 def get(item,target):
  req={k:item[k] for k in ('companyId','parentId','assetId','sha256')};req['output']=POD+'/retrieved.bin'
  invoke('retrieve',req,dest);receive(POD+'/retrieved.bin',target);kube(['rm','-f',POD+'/retrieved.bin'],capture_output=True)
  if digest(target)!=item['sha256']:raise RuntimeError('Retrieved object checksum mismatch')
 get(receipt['manifest'],dest/'recovery-manifest.bin')
 # Use the DAM manifest for recovery, not the local snapshot's content inventory.
 manifest=json.loads((dest/'recovery-manifest.bin').read_text())
 if manifest['companyId']!=receipt['companyId'] or manifest['runId']!=receipt['runId']:raise RuntimeError('DAM manifest scope mismatch')
 get(manifest['key'],dest/'recovery.key')
 encrypted=dest/'snapshot.aesgcm'
 with encrypted.open('wb') as out:
  for index,item in enumerate(manifest['parts']):
   part=dest/('part-'+str(index)+'.bin');get(item,part)
   with part.open('rb') as f:shutil.copyfileobj(f,out)
   part.unlink()
 if digest(encrypted)!=manifest['encryptedSha256']:raise RuntimeError('Encrypted assembly mismatch')
 archive=dest/'snapshot.tar.gz'
 subprocess.run(['node',str(TOOLS/'Backup-Crypto.mjs'),'decrypt',str(encrypted),str(archive),str(dest/'recovery.key')],check=True)
 if digest(archive)!=manifest['archiveSha256']:raise RuntimeError('Archive recovery mismatch')
 print(json.dumps({'companyId':manifest['companyId'],'state':'DAM_RETRIEVED_DECRYPTED_VERIFIED','restorePath':str(dest),'archiveSha256':manifest['archiveSha256']}),flush=True)
 save(dest/'restore-evidence.json',{'companyId':manifest['companyId'],'runId':manifest['runId'],'state':'DAM_RETRIEVED_DECRYPTED_VERIFIED','archiveSha256':manifest['archiveSha256']})

if __name__=='__main__':
 install_signal_handlers()
 p=argparse.ArgumentParser();p.add_argument('action',choices=['upload','restore']);p.add_argument('path',type=Path);args=p.parse_args();os.umask(0o077)
 path=args.path.resolve()
 if not path.is_relative_to(ROOT) or len(path.relative_to(ROOT).parts)!=2:raise RuntimeError('Expected scoped company/run capture directory')
 setup()
 try:(upload if args.action=='upload' else restore)(path)
 finally:kube(['rm','-f',POD+'/part.bin',POD+'/retrieved.bin',POD+'/request.json'],capture_output=True)

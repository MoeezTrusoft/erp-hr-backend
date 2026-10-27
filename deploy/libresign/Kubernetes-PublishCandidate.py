#!/usr/bin/env python3
"""Publish exactly one reviewed candidate archive, preserving digest and owned evidence."""
import argparse,json,os,subprocess,time
from pathlib import Path
from KubernetesBackupSignals import install_signal_handlers
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s');NS='trugit-build'
def kube(*args,**kw):return subprocess.run(['kubectl','-n',NS,*args],check=True,capture_output=True,timeout=45,**kw)
def main(folder):
 os.umask(0o077);plan_path=folder/'publish.json';plan=json.loads(plan_path.read_text());expected=json.loads((folder/'result.json').read_text())
 if expected['state']!='passed':raise RuntimeError('Archive verifier must pass first')
 for item in plan['items']:
  if item['kind'] not in ['Job','NetworkPolicy'] or item['metadata']['namespace']!=NS:raise RuntimeError('Publication boundary mismatch')
  exists=subprocess.run(['kubectl','-n',NS,'get',item['kind'],item['metadata']['name'],'-o','name'],capture_output=True)
  if exists.returncode==0:raise RuntimeError('Existing owned resource requires inspection')
 name=next(item['metadata']['name'] for item in plan['items'] if item['kind']=='Job')
 if name!='recruitment-alpine-publish-20261023':raise RuntimeError('Unexpected publisher identity')
 jobs=json.loads(kube('get','jobs','-o','json').stdout)['items']
 if any(not any(c['type'] in ['Complete','Failed'] and c['status']=='True' for c in j.get('status',{}).get('conditions',[])) for j in jobs):raise RuntimeError('Worker slot is occupied')
 try:
  kube('apply','-f',str(plan_path));deadline=time.monotonic()+660
  while time.monotonic()<deadline:
   job=json.loads(kube('get','job',name,'-o','json').stdout);conditions=job.get('status',{}).get('conditions',[])
   if any(c['type']=='Failed' and c['status']=='True' for c in conditions):raise RuntimeError('Publisher failed')
   if any(c['type']=='Complete' and c['status']=='True' for c in conditions):break
   time.sleep(4)
  else:raise RuntimeError('Publication deadline')
  log=kube('logs','job/'+name,'-c','publisher').stdout.decode()
  if 'PUBLISHED_DIGEST='+expected['manifestDigest'] not in log:raise RuntimeError('Registry digest differs from verified archive')
  receipt={'state':'PUBLISHED_DIGEST_VERIFIED','digest':expected['manifestDigest'],'archiveSha256':expected['archiveSha256']}
  (folder/'published.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt),flush=True)
 finally:
  log=subprocess.run(['kubectl','-n',NS,'logs','job/'+name,'--all-containers=true'],capture_output=True,timeout=45);(folder/'publish.log').write_bytes(log.stdout+log.stderr)
  kube('delete','-f',str(plan_path),'--ignore-not-found=true','--wait=false')
  for _ in range(45):
   if not json.loads(kube('get','pods','-l','job-name='+name,'-o','json').stdout)['items']:break
   time.sleep(2)
  else:raise RuntimeError('Publisher pod cleanup pending')
if __name__=='__main__':
 install_signal_handlers();p=argparse.ArgumentParser();p.add_argument('folder',type=Path);a=p.parse_args();folder=a.folder.resolve()
 if folder.parent!=ROOT or folder.name!='alpine-candidate-2c12f7c79ecc9bcc':raise RuntimeError('Expected reviewed protected candidate folder')
 main(folder)

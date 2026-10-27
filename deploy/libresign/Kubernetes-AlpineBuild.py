#!/usr/bin/env python3
"""One reviewed source build and OCI verification; never auto-retry a failed build."""
import argparse,hashlib,json,os,subprocess,time
from pathlib import Path
from KubernetesBackupSignals import install_signal_handlers
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s')
NS='trugit-build'
def kube(*args,**kw):return subprocess.run(['kubectl','-n',NS,*args],check=True,capture_output=True,timeout=40,**kw)
def save(path,value):path.write_text(json.dumps(value,indent=2));os.chmod(path,0o600)
def complete(name,seconds):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  row=json.loads(kube('get','job',name,'-o','json').stdout)
  statuses={x['type']:x['status'] for x in row.get('status',{}).get('conditions',[])}
  if statuses.get('Complete')=='True':return
  if statuses.get('Failed')=='True':raise RuntimeError('Reviewed Job failed: '+name)
  time.sleep(5)
 raise RuntimeError('Reviewed Job deadline: '+name)
def main(folder):
 os.umask(0o077)
 expected=json.loads((folder/'source.json').read_text());archive=folder/'source.tar.gz'
 if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected['archiveSha256']:raise RuntimeError('Source digest mismatch')
 plans={key:json.loads((folder/(key+'.json')).read_text()) for key in ['stage','build','verify']}
 for plan in plans.values():
  for obj in plan['items']:
   if obj['kind'] not in ['NetworkPolicy','ConfigMap','Job'] or obj['metadata']['namespace']!=NS:raise RuntimeError('Unexpected resource boundary')
 jobs=json.loads(kube('get','jobs','-o','json').stdout)['items']
 if any(not any(c['type'] in ('Complete','Failed') and c['status']=='True' for c in j.get('status',{}).get('conditions',[])) for j in jobs):raise RuntimeError('Another worker Job has not finished')
 owned=[]
 def launch(key):
  plan=plans[key];job=next(o for o in plan['items'] if o['kind']=='Job');name=job['metadata']['name']
  for obj in plan['items']:
   r=subprocess.run(['kubectl','-n',NS,'get',obj['kind'],obj['metadata']['name'],'-o','name'],capture_output=True,timeout=30)
   if r.returncode==0:raise RuntimeError('Owned resource name already exists; inspect before retry')
  owned.append((key,plan,name));kube('apply','-f',str(folder/(key+'.json')));return name
 def cleanup(item):
  key,plan,name=item
  log=subprocess.run(['kubectl','-n',NS,'logs','job/'+name,'--all-containers=true'],capture_output=True,timeout=40)
  (folder/(key+'.log')).write_bytes(log.stdout+log.stderr)
  kube('delete','-f',str(folder/(key+'.json')),'--ignore-not-found=true','--wait=false')
  for _ in range(30):
   pods=json.loads(kube('get','pods','-l','job-name='+name,'-o','json').stdout)['items']
   if not pods:break
   time.sleep(2)
  else:raise RuntimeError('Owned pod cleanup did not finish')
 try:
  name=launch('stage')
  deadline=time.monotonic()+180
  while time.monotonic()<deadline:
   pods=json.loads(kube('get','pod','-l','job-name='+name,'-o','json').stdout)['items']
   if pods and pods[0]['status'].get('phase')=='Running':break
   time.sleep(2)
  else:raise RuntimeError('Staging pod unavailable')
  pod=pods[0]['metadata']['name']
  script="import sys,hashlib,os;from pathlib import Path;p=Path('/input/alpine-source.tar.gz');data=sys.stdin.buffer.read();assert hashlib.sha256(data).hexdigest()==sys.argv[1];assert not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[1];q=p.with_suffix('.partial');q.write_bytes(data);os.replace(q,p)"
  with archive.open('rb') as source:subprocess.run(['kubectl','-n',NS,'exec','-i',pod,'--','python3','-c',script,expected['archiveSha256']],stdin=source,check=True,capture_output=True,timeout=180)
  complete(name,300);cleanup(owned[-1]);owned.pop();save(folder/'state.json',{'state':'SOURCE_VERIFIED'})
  name=launch('build');complete(name,2400);cleanup(owned[-1]);owned.pop();save(folder/'state.json',{'state':'IMAGE_BUILT'})
  name=launch('verify');complete(name,300)
  log=kube('logs','job/'+name).stdout.decode();receipt=json.loads(log.strip().splitlines()[-1]);save(folder/'result.json',receipt)
  cleanup(owned[-1]);owned.pop();save(folder/'state.json',{'state':'BUILD_AND_ARCHIVE_VERIFIED','receipt':receipt});print(json.dumps(receipt),flush=True)
 finally:
  for item in reversed(owned):cleanup(item)
if __name__=='__main__':
 install_signal_handlers();p=argparse.ArgumentParser();p.add_argument('folder',type=Path);a=p.parse_args();folder=a.folder.resolve()
 if folder.parent!=ROOT or not folder.name.startswith('alpine-candidate-'):raise RuntimeError('Protected reviewed plan folder required')
 main(folder)

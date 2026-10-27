#!/usr/bin/env python3
"""Collect hash-bound Kubernetes scanner reports before removing owned resources."""
import base64,hashlib,json,os,subprocess,time,zlib
from pathlib import Path
from KubernetesBackupSignals import install_signal_handlers
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/alpine-candidate-2c12f7c79ecc9bcc');NS='trugit-build';NAME='tg-tool-scan-libresign-alpine'
def kube(*args,**kw):return subprocess.run(['kubectl','-n',NS,*args],check=True,capture_output=True,timeout=45,**kw)
def main():
 os.umask(0o077);output=ROOT/'scan-results';output.mkdir(exist_ok=True,mode=0o700)
 try:
  deadline=time.monotonic()+1250
  while time.monotonic()<deadline:
   row=json.loads(kube('get','job',NAME,'-o','json').stdout)
   conditions=row.get('status',{}).get('conditions',[])
   if any(c['type'] in ['Complete','Failed'] and c['status']=='True' for c in conditions):break
   time.sleep(5)
  else:raise RuntimeError('Cluster scan deadline')
  (output/'job.json').write_text(json.dumps(row,indent=2));(output/'pods.json').write_bytes(kube('get','pod','-l','job-name='+NAME,'-o','json').stdout)
  raw=kube('logs','job/'+NAME,'-c','collect').stdout;(output/'collector.log').write_bytes(raw)
  parts={};digests={};summaries=[];final=None
  for line in raw.decode().splitlines():
   value=json.loads(line)
   if value['type']=='file':parts.setdefault(value['name'],{})[value['index']]=value['data']
   elif value['type']=='digest':digests[value['name']]=value
   elif value['type']=='summary':summaries.append(value)
   elif value['type']=='complete':final=value
  for name,digest in digests.items():
   if Path(name).name!=name:raise RuntimeError('Invalid report path')
   chunks=parts[name]
   if set(chunks)!=set(range(len(chunks))):raise RuntimeError('Missing report chunk')
   data=zlib.decompress(base64.b64decode(''.join(chunks[i] for i in range(len(chunks)))))
   if len(data)!=digest['bytes'] or hashlib.sha256(data).hexdigest()!=digest['sha256']:raise RuntimeError('Report digest mismatch')
   (output/name).write_bytes(data)
  if not final or not final['scansComplete'] or not final['coverageComplete']:raise RuntimeError('Scan coverage is incomplete')
  receipt={'state':'SCANNED_IN_KUBERNETES','summary':summaries,'complete':final,'reportDigests':digests}
  (output/'receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps({'state':receipt['state'],'cleanCriticalHigh':final['clean'],'images':[{'image':s['image'],'counts':s['counts']} for s in summaries]}),flush=True)
 finally:
  diagnostics=subprocess.run(['kubectl','-n',NS,'logs','job/'+NAME,'-c','scan'],capture_output=True,timeout=45);(output/'scan.log').write_bytes(diagnostics.stdout+diagnostics.stderr)
  kube('delete','-f',str(ROOT/'scan.json'),'--ignore-not-found=true','--wait=false')
  for _ in range(45):
   if not json.loads(kube('get','pod','-l','job-name='+NAME,'-o','json').stdout)['items']:break
   time.sleep(2)
  else:raise RuntimeError('Owned scanner cleanup pending')
if __name__=='__main__':install_signal_handlers();main()

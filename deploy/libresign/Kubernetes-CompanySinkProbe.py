#!/usr/bin/env python3
"""Synthetic public-prefix signing, executable only for no-public-mail companies."""
import argparse,base64,hashlib,importlib.util,json,os,subprocess,time
from pathlib import Path
from KubernetesBackupLock import backup_run_lock
from KubernetesBackupSignals import install_signal_handlers
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s');TOOLS=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('rollout',TOOLS/'Kubernetes-AlpineRollout.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
def k(*args,**kw):kw.setdefault('timeout',60);return subprocess.run(['kubectl',*args],check=True,capture_output=True,**kw)
def main(name):
 os.umask(0o077);cid=r.COMPANIES[name];ns='sign-'+name;folder=ROOT/'alpine-rollout'/name;job='recruitment-signing-acceptance';label={'recruitment-signing-acceptance':'true'}
 with backup_run_lock(ROOT/'backups'):
  assert json.loads((folder/'state.json').read_text())['state']=='DEPLOYED_HTTPS_ACCEPTANCE_PASS'
  assert r.occ(ns,'config:system:get','mail_smtphost').stdout.strip()=='mailpit'
  assert r.occ(ns,'config:system:get','mail_smtpport').stdout.strip()=='1025'
  assert r.occ(ns,'config:app:get','libresign','signature_engine').stdout.strip()=='PhpNative'
  before=json.loads(k('-n',ns,'get','deployment','app','-o','json').stdout);assert all(c['image']==r.CANDIDATE for c in before['spec']['template']['spec']['containers'])
  mailpods=json.loads(k('-n',ns,'get','pods','-l','app=mailpit','-o','json').stdout)['items'];assert len(mailpods)==1;mailip=mailpods[0]['status']['podIP']
  metadata=lambda name:{'name':name,'namespace':ns,'labels':label}
  policies=[{'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':metadata(job),'spec':{'podSelector':{'matchLabels':label},'policyTypes':['Ingress','Egress'],'ingress':[],'egress':[{'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}}}],'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]},{'to':[{'podSelector':{'matchLabels':{'app':'mailpit'}}}],'ports':[{'protocol':'TCP','port':8025}]},{'to':[{'ipBlock':{'cidr':'103.245.195.3/32'}}],'ports':[{'protocol':'TCP','port':443}]}]}},{'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':metadata(job+'-mail'),'spec':{'podSelector':{'matchLabels':{'app':'mailpit'}},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{'matchLabels':label}}],'ports':[{'protocol':'TCP','port':8025}]}]}}]
  workload={'apiVersion':'batch/v1','kind':'Job','metadata':metadata(job),'spec':{'backoffLimit':0,'activeDeadlineSeconds':600,'template':{'metadata':{'labels':label},'spec':{'restartPolicy':'Never','nodeSelector':{'kubernetes.io/hostname':'erptrusoft'},'automountServiceAccountToken':False,'terminationGracePeriodSeconds':5,'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'seccompProfile':{'type':'RuntimeDefault'}},'containers':[{'name':'client','image':'localhost:5000/trusoft-erp/erp-hr:main-9c882c9d9b60@sha256:7a4e64f8b2c3310ade4d15cdb1cf41bcf2d6fa4539d4dd44f95c78ae6bc8909f','imagePullPolicy':'IfNotPresent','command':['node','-e','setInterval(()=>{},3600000)'],'securityContext':{'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'resources':{'requests':{'cpu':'1m','memory':'32Mi'},'limits':{'cpu':'300m','memory':'256Mi'}}}]}}}}
  resources={'apiVersion':'v1','kind':'List','items':policies+[workload]};path=folder/'sink-probe-resources.json';r.save(path,resources);created=False
  try:
   assert subprocess.run(['kubectl','-n',ns,'get','job',job],capture_output=True,timeout=15).returncode!=0
   k('apply','-f',str(path));created=True;k('-n',ns,'wait','--for=condition=Ready','pod','-l','job-name='+job,'--timeout=120s',timeout=150)
   pod=json.loads(k('-n',ns,'get','pod','-l','job-name='+job,'-o','json').stdout)['items'][0]['metadata']['name']
   source=Path('/home/erp_trusoft/recruitment-libresign-companies')/cid
   config={'namespace':ns,'companyId':cid,'base':'https://erp.trusoft.ai/signing/'+cid,'mailBase':'http://'+mailip+':8025','passwordFile':'/tmp/company-password','pdf':'/tmp/company-probe.pdf','signedOutput':'/tmp/company-signed.pdf'}
   files={'Smoke-CompanySink.mjs':(TOOLS/'Smoke-CompanySink.mjs').read_bytes(),'libresignClient.mjs':(TOOLS/'libresignClient.mjs').read_bytes(),'company-password':(source/'.secrets'/(cid+'.app-password')).read_bytes(),'company-probe.pdf':(source/'.runtime/synthetic-offer.pdf').read_bytes(),'company-config.json':json.dumps(config).encode()}
   payload=json.dumps({n:base64.b64encode(v).decode() for n,v in files.items()});assert len(payload.encode())<60000
   bootstrap="const fs=require('node:fs'),{spawnSync}=require('node:child_process');process.umask(0o077);for(const [n,d] of Object.entries(JSON.parse(fs.readFileSync(0,'utf8')))){if(!/^[A-Za-z0-9.-]+$/.test(n))throw Error('Invalid fixture path');fs.writeFileSync('/tmp/'+n,Buffer.from(d,'base64'),{mode:0o600});}const r=spawnSync(process.execPath,['/tmp/Smoke-CompanySink.mjs','/tmp/company-config.json'],{stdio:'inherit',timeout:330000});process.exitCode=r.status??1;"
   result=subprocess.run(['kubectl','-n',ns,'exec','-i',pod,'--','node','-e',bootstrap],input=payload,capture_output=True,text=True,timeout=360);(folder/'sink-probe.log').write_text(result.stdout+result.stderr)
   if result.returncode:raise RuntimeError('Signing acceptance failed; inspect protected sink-probe.log')
   signed=k('-n',ns,'exec',pod,'--','cat','/tmp/company-signed.pdf').stdout;sha=hashlib.sha256(signed).hexdigest();(folder/'sink-signed.pdf').write_bytes(signed)
   target='/tmp/recruitment-sink-acceptance.pdf';k('-n',ns,'exec','deployment/app','-c','app','--','php','-r',"file_put_contents('"+target+"','');")
   for start in range(0,len(signed),32768):k('-n',ns,'exec','-i','deployment/app','-c','app','--','php','-r',"file_put_contents('"+target+"',file_get_contents('php://stdin'),FILE_APPEND);",input=signed[start:start+32768])
   actual=k('-n',ns,'exec','deployment/app','-c','app','--','sha256sum',target,text=True).stdout.split()[0];assert actual==sha
   checked=k('-n',ns,'exec','deployment/app','-c','app','--','timeout','20','pdfsig','-nocert',target,text=True).stdout;(folder/'sink-pdfsig.txt').write_text(checked)
   assert 'Signature is Valid' in checked and 'Total document signed' in checked
   k('-n',ns,'exec','deployment/app','-c','app','--','rm','--',target)
   receipt={'state':'PUBLIC_PREFIX_SINK_SIGNING_PASS','company':name,'image':r.CANDIDATE,'signedSha256':sha,'cryptographicSignature':'VALID_WHOLE_DOCUMENT','publicMailSent':False,'workflowErased':True}
   r.save(folder/'sink-signing-acceptance.json',receipt);print(json.dumps(receipt),flush=True)
  finally:
   install_signal_handlers(defer=True)
   if created:k('delete','-f',str(path),'--wait=true','--timeout=60s',timeout=90)
if __name__=='__main__':
 install_signal_handlers();p=argparse.ArgumentParser();p.add_argument('--company',choices=['homenet','joc'],required=True);main(p.parse_args().company)

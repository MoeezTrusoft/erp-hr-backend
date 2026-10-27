#!/usr/bin/env python3
"""Restore a DAM-retrieved snapshot in an isolated Kubernetes pod, with no public ingress or egress."""
import argparse
import re
import base64
from RegistryAliasProof import verify_live
from KubernetesBackupSignals import install_signal_handlers
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time
import uuid

ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')
TOOLS=Path(__file__).resolve().parent

def kubectl(*args,**kwargs):
 kwargs.setdefault('timeout',90)
 try:return subprocess.run(['kubectl',*args],check=True,**kwargs)
 except subprocess.CalledProcessError as error:
  detail=error.stderr or error.stdout or b''
  if isinstance(detail,bytes):detail=detail.decode('utf8',errors='replace')
  (ROOT/'native-signing-kubectl-error.log').write_text(detail);os.chmod(ROOT/'native-signing-kubectl-error.log',0o600)
  raise
def save(path,obj):path.write_text(json.dumps(obj,indent=2));os.chmod(path,0o600)
def main(path,app_image=None):
 if app_image:
  if not re.fullmatch(r'localhost:5000/erp-build/libresign-alpine@sha256:[a-f0-9]{64}',app_image):raise RuntimeError('Qualified pinned node alias required')
  class KubeRead:
   def get(self,kind,name=None,namespace=None,selector=None):
    args=['get',kind]+([name] if name else [])+(['-n',namespace] if namespace else [])+(['-l',selector] if selector else [])+['-o','json']
    return json.loads(kubectl(*args,capture_output=True).stdout)
  verify_live(KubeRead(),json.loads(Path('/opt/erp-cicd/trugit-k8s-ci-20261023/registry/receipts/qualification.json').read_text()))
 os.umask(0o077);evidence=json.loads((path/'restore-evidence.json').read_text());cid=evidence['companyId'];archive=path/'snapshot.tar.gz';extracted=path/('native-extracted-'+str(uuid.uuid4()));extracted.mkdir(mode=0o700)
 with tarfile.open(archive,'r:gz') as tar:
  for member in tar.getmembers():
   p=Path(member.name)
   if p.is_absolute() or '..' in p.parts or p.parts[0] not in ('nextcloud','metadata'):raise RuntimeError('Unsafe archive member')
  def safe_member(member,destination):
   checked=tarfile.data_filter(member,destination)
   return checked.replace(uid=member.uid,gid=member.gid,mode=member.mode & 0o777) if checked else None
  # The standard filter resolves symlinks relative to their containing directory.
  # Legitimate JRE license links remain valid; links escaping the restore root fail.
  tar.extractall(extracted,filter=safe_member)
 meta=extracted/'metadata';manifest=json.loads((meta/'manifest.json').read_text())
 if manifest['companyId']!=cid:raise RuntimeError('Backup company mismatch')
 actual=hashlib.sha256((meta/'database.dump').read_bytes()).hexdigest()
 if actual!=manifest['databaseSha256']:raise RuntimeError('Database dump mismatch')
 name='sign-native-'+manifest['company'];ns={'apiVersion':'v1','kind':'Namespace','metadata':{'name':name,'labels':{'purpose':'libresign-native-probe'}}}
 secret=json.loads((meta/'runtime-secret.json').read_text());secret={k:secret[k] for k in ('apiVersion','kind','type','data')};secret['metadata']={'name':'runtime','namespace':name}
 image=manifest['images']
 if app_image:
  image['app']=app_image
 mounts=[{'name':'runtime','mountPath':'/run/secrets','readOnly':True}]
 resources=lambda memory:{'requests':{'cpu':'1m','memory':'32Mi'},'limits':{'cpu':'300m','memory':memory}}
 pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':'restore','namespace':name,'labels':{'purpose':'libresign-native-probe'}},'spec':{'nodeName':'erptrusoft','restartPolicy':'Never','automountServiceAccountToken':False,'terminationGracePeriodSeconds':10,'containers':[
 {'name':'db','image':image['db'],'imagePullPolicy':'IfNotPresent','env':[{'name':'POSTGRES_DB','value':'libresign'},{'name':'POSTGRES_USER','value':'libresign'},{'name':'POSTGRES_PASSWORD_FILE','value':'/run/secrets/database_password'}],'resources':resources('512Mi'),'volumeMounts':mounts+[{'name':'database','mountPath':'/var/lib/postgresql/data'}]},
 {'name':'redis','image':image['redis'],'resources':resources('128Mi')},
 {'name':'app','image':image['app'],'imagePullPolicy':'Always' if app_image else 'IfNotPresent','command':['/bin/sh','-c','sleep 3600'],'resources':resources('1536Mi'),'volumeMounts':mounts+[{'name':'nextcloud','mountPath':'/var/www/html'}]}
 ,{'name':'mailpit','image':'docker.io/axllent/mailpit:latest@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387','resources':resources('128Mi')}
 ,{'name':'client','image':'localhost:5000/trusoft-erp/erp-hr:main-9c882c9d9b60@sha256:7a4e64f8b2c3310ade4d15cdb1cf41bcf2d6fa4539d4dd44f95c78ae6bc8909f','imagePullPolicy':'IfNotPresent','command':['node','-e','setInterval(()=>{},3600000)'],'resources':resources('256Mi'),'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']},'seccompProfile':{'type':'RuntimeDefault'}}}
 ],'volumes':[{'name':'runtime','secret':{'secretName':'runtime'}},{'name':'database','emptyDir':{}},{'name':'nextcloud','hostPath':{'path':str(extracted/'nextcloud'),'type':'Directory'}}]}}
 # Exercise the exact production nonroot read-only web sidecar with fresh writable directories.
 import importlib.util
 module_spec=importlib.util.spec_from_file_location('rollout_web',TOOLS/'Kubernetes-AlpineRollout.py');rollout=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(rollout)
 pod['spec']['securityContext']={'fsGroup':33,'fsGroupChangePolicy':'OnRootMismatch','seccompProfile':{'type':'RuntimeDefault'}}
 pod['spec']['containers'].append(rollout.web_container(image['app']))
 pod['spec']['volumes'] += [{'name':'nginx-run','emptyDir':{'sizeLimit':'16Mi'}},{'name':'nginx-state','emptyDir':{'sizeLimit':'128Mi'}}]
 deny={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'deny-external-traffic','namespace':name},'spec':{'podSelector':{},'policyTypes':['Ingress','Egress'],'ingress':[],'egress':[]}}
 # This edits the disposable copy only; real company DB, files and services are untouched.
 php="<?php include '/var/www/html/config/config.php'; $CONFIG['dbhost']='127.0.0.1'; $CONFIG['redis']['host']='127.0.0.1'; $CONFIG['redis']['port']=6379; unset($CONFIG['redis']['password']); $CONFIG['mail_smtphost']='127.0.0.1'; $CONFIG['mail_smtpport']=1025; $CONFIG['mail_smtpauth']=false; $CONFIG['mail_smtpsecure']=''; $CONFIG['mail_from_address']='native-probe'; $CONFIG['mail_domain']='example.invalid'; $CONFIG['maintenance']=false; $CONFIG['trusted_domains']=['127.0.0.1']; $CONFIG['overwritehost']='127.0.0.1:8080'; $CONFIG['overwriteprotocol']='http'; $CONFIG['overwritewebroot']=''; $CONFIG['htaccess.RewriteBase']='/'; $CONFIG['overwrite.cli.url']='http://127.0.0.1:8080'; file_put_contents('/var/www/html/config/config.php','<?php'.PHP_EOL.'$CONFIG = '.var_export($CONFIG,true).';'.PHP_EOL);"
 helper=extracted/'nextcloud'/'restore-config.php';helper.write_text(php);os.chmod(helper,0o644)
 own_namespace=False
 try:
  existing=subprocess.run(['kubectl','get','ns',name],capture_output=True)
  if existing.returncode==0:raise RuntimeError('Restore namespace already exists; inspect before retry')
  own_namespace=True
  kubectl('apply','-f','-',input=json.dumps({'apiVersion':'v1','kind':'List','items':[ns,secret,deny,pod]}),text=True,capture_output=True)
  kubectl('-n',name,'wait','--for=condition=Ready','pod/restore','--timeout=180s',capture_output=True,timeout=220)
  for _ in range(60):
   p=subprocess.run(['kubectl','-n',name,'exec','restore','-c','db','--','pg_isready','-h','127.0.0.1','-U','libresign','-d','libresign'],capture_output=True)
   if p.returncode==0:break
   time.sleep(2)
  else:raise RuntimeError('Recovery database unavailable')
  # Nextcloud creates its own database role. Its password is already in the
  # encrypted config.php; keep it in memory and send SQL over stdin, never argv/logs.
  account_result=kubectl('-n',name,'exec','restore','-c','app','--','php','-r',"include '/var/www/html/config/config.php'; echo json_encode(['user'=>$CONFIG['dbuser'],'password'=>$CONFIG['dbpassword']]);",capture_output=True,text=True)
  account=json.loads(account_result.stdout)
  if not isinstance(account.get('user'),str) or not isinstance(account.get('password'),str):raise RuntimeError('Application database account is absent')
  if account['user']!='libresign':
   identifier='"'+account['user'].replace('"','""')+'"'
   literal="'"+account['password'].replace("'","''")+"'"
   sql='SET standard_conforming_strings=on; CREATE ROLE '+identifier+' LOGIN PASSWORD '+literal+';'
   kubectl('-n',name,'exec','-i','restore','-c','db','--','psql','-U','libresign','-d','libresign','-v','ON_ERROR_STOP=1',input=sql,capture_output=True,text=True)
  account.clear()
  with (meta/'database.dump').open('rb') as f:kubectl('-n',name,'exec','-i','restore','-c','db','--','pg_restore','-U','libresign','-d','libresign','--exit-on-error',stdin=f,capture_output=True)
  kubectl('-n',name,'exec','restore','-c','app','--','php','/var/www/html/restore-config.php',capture_output=True)
  helper.unlink()
  status=kubectl('-n',name,'exec','restore','-c','app','--','su','-s','/bin/sh','www-data','-c','php occ status --output=json',capture_output=True,text=True)
  value=json.loads(status.stdout)
  if value.get('installed') is not True or value.get('needsDbUpgrade') is True:raise RuntimeError('Restored Nextcloud is not ready')
  counts=kubectl('-n',name,'exec','restore','-c','db','--','psql','-U','libresign','-d','libresign','-At','-c',"SELECT json_build_object('users',(SELECT count(*) FROM oc_users),'signingTables',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'oc_libresign%'),'appSettings',(SELECT count(*) FROM oc_appconfig));",capture_output=True,text=True)
  run_native_probe(name,cid,path,meta, bool(app_image))
  evidence.update({'state':'NATIVE_SIGNING_ISOLATED_PASS','image':image['app'],'engine':'PhpNative','webStack':'NGINX_FPM_READONLY_NONROOT_SIDECAR','webContainerSha256':hashlib.sha256(json.dumps(rollout.web_container(image['app']),sort_keys=True).encode()).hexdigest(),'cryptographicSignature':'VALID_WHOLE_DOCUMENT','nextcloudVersion':value.get('version'),'databaseCounts':json.loads(counts.stdout),'isolated':True,'publicMailSent':False})
  save(path/'native-signing-evidence.json',evidence);print(json.dumps(evidence),flush=True)
 finally:
  # Only this probe's exact namespace can be deleted; the five live namespaces are never targeted.
  install_signal_handlers(defer=True)
  found=subprocess.run(['kubectl','get','namespace',name,'-o','json'],capture_output=True,text=True,timeout=30)
  if own_namespace and found.returncode==0 and json.loads(found.stdout)['metadata'].get('labels',{}).get('purpose')=='libresign-native-probe':kubectl('delete','namespace',name,'--wait=true','--timeout=120s',capture_output=True,timeout=140)


def run_native_probe(namespace,cid,path,meta,fpm=False):
 def app(*args,**kw):return kubectl('-n',namespace,'exec','restore','-c','app','--',*args,**kw)
 def occ(command):return app('su','-s','/bin/sh','www-data','-c','php occ '+command,capture_output=True,text=True)
 occ('config:app:set libresign signature_engine --value=PhpNative')
 for key in ['java_path','pdftk_path','jsignpdf_path']:occ('config:app:set libresign '+key+' --value=/native-disabled/'+key)
 if fpm:app('/bin/sh','-ec','php-fpm -D >/tmp/native-fpm.log 2>&1 </dev/null',capture_output=True,timeout=30)
 else:raise RuntimeError('Candidate qualification requires NGINX/FPM')
 config={'namespace':namespace,'companyId':cid,'base':'http://127.0.0.1:8080','passwordFile':'/tmp/native-probe-password','pdf':'/tmp/native-probe.pdf','signedOutput':'/tmp/native-signed.pdf'}
 files={'Smoke-NativeSigning.mjs':(TOOLS/'Smoke-NativeSigning.mjs').read_bytes(),'libresignClient.mjs':(TOOLS/'libresignClient.mjs').read_bytes(),'native-probe-password':(meta/'hr-app-password').read_bytes(),'native-probe.pdf':Path('/home/erp_trusoft/recruitment-libresign-companies/'+cid+'/.runtime/synthetic-offer.pdf').read_bytes(),'native-probe-config.json':json.dumps(config).encode()}
 # The synthetic client runs inside the deny-egress Pod. Input secrets travel only over exec stdin.
 payload=json.dumps({k:base64.b64encode(v).decode() for k,v in files.items()})
 bootstrap=r'''const fs=require('node:fs');const {spawnSync}=require('node:child_process');process.umask(0o077);const files=JSON.parse(fs.readFileSync(0,'utf8'));for(const [name,data] of Object.entries(files)){if(!/^[A-Za-z0-9.-]+$/.test(name))throw Error('Invalid test path');fs.writeFileSync('/tmp/'+name,Buffer.from(data,'base64'),{mode:0o600});}const result=spawnSync(process.execPath,['/tmp/Smoke-NativeSigning.mjs','/tmp/native-probe-config.json'],{stdio:'inherit',timeout:300000});process.exitCode=result.status??1;'''
 result=subprocess.run(['kubectl','-n',namespace,'exec','-i','restore','-c','client','--','node','-e',bootstrap],input=payload,capture_output=True,text=True,timeout=330)
 (path/'native-signing.log').write_text(result.stdout+result.stderr);os.chmod(path/'native-signing.log',0o600)
 if result.returncode:raise RuntimeError('Native signing did not pass; inspect protected native-signing.log')
 signed=kubectl('-n',namespace,'exec','restore','-c','client','--','cat','/tmp/native-signed.pdf',capture_output=True).stdout
 (path/'native-signed.pdf').write_bytes(signed);os.chmod(path/'native-signed.pdf',0o600)
 app('sh','-c','mkdir -p /root/.pki/nssdb; : > /tmp/native-signed.pdf',capture_output=True)
 # Keep exec stdin below the runtime transport frame boundary; verify the entire copy.
 for offset in range(0,len(signed),32768):
  kubectl('-n',namespace,'exec','-i','restore','-c','app','--','php','-r',"file_put_contents('/tmp/native-signed.pdf',file_get_contents('php://stdin'),FILE_APPEND);",input=signed[offset:offset+32768],capture_output=True)
 copied=app('sha256sum','/tmp/native-signed.pdf',capture_output=True,text=True).stdout.split()[0]
 if copied!=hashlib.sha256(signed).hexdigest():raise RuntimeError('Verifier PDF transfer checksum mismatch')
 verification=app('timeout','20','pdfsig','-nocert','/tmp/native-signed.pdf',capture_output=True,text=True).stdout
 (path/'native-pdfsig.txt').write_text(verification);os.chmod(path/'native-pdfsig.txt',0o600)
 if 'Signature is Valid' not in verification or 'Total document signed' not in verification:raise RuntimeError('Whole-document cryptographic validation failed')

if __name__=='__main__':
 install_signal_handlers()
 p=argparse.ArgumentParser();p.add_argument('path',type=Path);p.add_argument('--app-image');args=p.parse_args();target=args.path.resolve()
 if not target.is_relative_to(ROOT) or len(target.relative_to(ROOT).parts)!=3 or not target.name.startswith('restore-'):raise RuntimeError('Expected isolated restore directory')
 main(target,args.app_image)

#!/usr/bin/env python3
"""Restore a DAM-retrieved snapshot in an isolated Kubernetes pod, with no public ingress or egress."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time
import uuid

ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')

def kubectl(*args,**kwargs):
 try:return subprocess.run(['kubectl',*args],check=True,**kwargs)
 except subprocess.CalledProcessError as error:
  detail=error.stderr or error.stdout or b''
  if isinstance(detail,bytes):detail=detail.decode('utf8',errors='replace')
  (ROOT/'restore-kubectl-error.log').write_text(detail);os.chmod(ROOT/'restore-kubectl-error.log',0o600)
  raise
def save(path,obj):
 temporary=path.with_name(path.name+'.pending-'+str(uuid.uuid4()))
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'w') as stream:
   json.dump(obj,stream,indent=2);stream.flush();os.fsync(stream.fileno())
  os.replace(temporary,path)
 finally:
  if temporary.exists():temporary.unlink()

RESTORE_COMPANIES={'trusoft','boc','homevision','homenet','joc'}

def restore_name(company):
 if company not in RESTORE_COMPANIES:raise RuntimeError('Unknown restore company')
 return 'sign-restore-'+company

def namespace_call(kube,*args,deadline,**kwargs):
 remaining=deadline-time.monotonic()
 if remaining<=0:raise TimeoutError('Restore namespace API deadline')
 request_seconds=max(1,min(20,int(remaining)))
 return kube(*args,'--request-timeout='+str(request_seconds)+'s',capture_output=True,text=True,
             timeout=min(30,remaining),**kwargs)

def create_restore_namespace(namespace,kube=kubectl):
 name=namespace['metadata']['name']
 if name not in {restore_name(company) for company in RESTORE_COMPANIES}:raise RuntimeError('Restore namespace scope')
 deadline=time.monotonic()+60
 found=namespace_call(kube,'get','namespace',name,'--ignore-not-found','-o','json',deadline=deadline)
 if found.stdout.strip():raise RuntimeError('Restore namespace already exists; inspect before retry')
 # --ignore-not-found returns empty success only for absence; API failures raise.
 result=namespace_call(kube,'create','-f','-','-o','json',input=json.dumps(namespace),deadline=deadline)
 created=json.loads(result.stdout)
 if created.get('kind')!='Namespace' or created['metadata'].get('name')!=name or created['metadata'].get('labels',{}).get('purpose')!='libresign-restore-probe':raise RuntimeError('Created namespace identity mismatch')
 uid=created['metadata'].get('uid');uuid.UUID(uid)
 return uid

def owned_restore_pod(pod,name,namespace_uid,expected_uid=None):
 metadata=pod.get('metadata',{})
 owner={'apiVersion':'v1','kind':'Namespace','name':name,'uid':namespace_uid}
 references=metadata.get('ownerReferences',[])
 if (pod.get('kind')!='Pod' or metadata.get('name')!='restore' or metadata.get('namespace')!=name
     or metadata.get('labels',{}).get('purpose')!='libresign-restore-probe'
     or len(references)!=1 or any(references[0].get(k)!=v for k,v in owner.items())):
  raise RuntimeError('Restore pod ownership changed; cleanup refused')
 pod_uid=metadata.get('uid');uuid.UUID(pod_uid)
 if expected_uid is not None and pod_uid!=expected_uid:raise RuntimeError('Restore pod UID changed; cleanup refused')
 return pod_uid

def cleanup_restore_namespace(name,uid,kube=kubectl,pause=time.sleep,pod_uid=None,progress=None):
 if name not in {restore_name(company) for company in RESTORE_COMPANIES}:raise RuntimeError('Restore cleanup scope')
 uuid.UUID(uid)
 deadline=time.monotonic()+120
 def observed():
  found=namespace_call(kube,'get','namespace',name,'--ignore-not-found','-o','json',deadline=deadline)
  if not found.stdout.strip():return False
  current=json.loads(found.stdout)
  if current['metadata'].get('name')!=name or current['metadata'].get('uid')!=uid or current['metadata'].get('labels',{}).get('purpose')!='libresign-restore-probe':raise RuntimeError('Restore namespace UID or scope changed; cleanup refused')
  return True
 if not observed():return
 # Namespace garbage collection can delete NetworkPolicy before its pods.
 # Keep that namespace and its deny policy intact until the exact owned pod is absent.
 def current_pod(expected_uid):
  result=namespace_call(kube,'-n',name,'get','pods','-o','json',deadline=deadline)
  items=json.loads(result.stdout).get('items')
  if not isinstance(items,list) or len(items)>1:raise RuntimeError('Unexpected restore namespace pods; cleanup refused')
  if not items:return None
  return owned_restore_pod(items[0],name,uid,expected_uid)
 found_uid=current_pod(pod_uid)
 if found_uid is not None:
  options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':found_uid},'propagationPolicy':'Foreground','gracePeriodSeconds':10}
  namespace_call(kube,'delete','--raw','/api/v1/namespaces/'+name+'/pods/restore','-f','-',input=json.dumps(options),deadline=deadline)
  while current_pod(found_uid) is not None:
   pause(min(1,max(0,deadline-time.monotonic())))
 if progress is not None:progress('POD_ABSENT')
 # Recheck identity after pod termination; never delete a replacement namespace.
 if not observed():return
 options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':uid},'propagationPolicy':'Foreground'}
 namespace_call(kube,'delete','--raw','/api/v1/namespaces/'+name,'-f','-',input=json.dumps(options),deadline=deadline)
 while time.monotonic()<deadline:
  if not observed():return
  pause(min(2,max(0,deadline-time.monotonic())))
 raise TimeoutError('Restore namespace cleanup deadline')

def main(path):
 os.umask(0o077);evidence=json.loads((path/'restore-evidence.json').read_text());cid=evidence['companyId'];archive=path/'snapshot.tar.gz';extracted=path/('extracted-'+str(uuid.uuid4()));extracted.mkdir(mode=0o700)
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
 name=restore_name(manifest['company']);ns={'apiVersion':'v1','kind':'Namespace','metadata':{'name':name,'labels':{'purpose':'libresign-restore-probe'}}}
 secret=json.loads((meta/'runtime-secret.json').read_text());secret={k:secret[k] for k in ('apiVersion','kind','type','data')};secret['metadata']={'name':'runtime','namespace':name}
 image=manifest['images'];mounts=[{'name':'runtime','mountPath':'/run/secrets','readOnly':True}]
 resources=lambda memory:{'requests':{'cpu':'1m','memory':'32Mi'},'limits':{'cpu':'300m','memory':memory}}
 pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':'restore','namespace':name,'labels':{'purpose':'libresign-restore-probe'}},'spec':{'nodeName':'erptrusoft','restartPolicy':'Never','automountServiceAccountToken':False,'terminationGracePeriodSeconds':10,'containers':[
 {'name':'db','image':image['db'],'imagePullPolicy':'IfNotPresent','env':[{'name':'POSTGRES_DB','value':'libresign'},{'name':'POSTGRES_USER','value':'libresign'},{'name':'POSTGRES_PASSWORD_FILE','value':'/run/secrets/database_password'}],'resources':resources('512Mi'),'volumeMounts':mounts+[{'name':'database','mountPath':'/var/lib/postgresql/data'}]},
 {'name':'redis','image':image['redis'],'resources':resources('128Mi')},
 {'name':'app','image':image['app'],'imagePullPolicy':'Never','command':['/bin/sh','-c','sleep 3600'],'resources':resources('768Mi'),'volumeMounts':mounts+[{'name':'nextcloud','mountPath':'/var/www/html'}]}
 ],'volumes':[{'name':'runtime','secret':{'secretName':'runtime'}},{'name':'database','emptyDir':{}},{'name':'nextcloud','hostPath':{'path':str(extracted/'nextcloud'),'type':'Directory'}}]}}
 deny={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'deny-external-traffic','namespace':name},'spec':{'podSelector':{},'policyTypes':['Ingress','Egress'],'ingress':[],'egress':[]}}
 # This edits the disposable copy only; real company DB, files and services are untouched.
 php="<?php include '/var/www/html/config/config.php'; $CONFIG['dbhost']='127.0.0.1'; $CONFIG['redis']['host']='127.0.0.1'; $CONFIG['redis']['port']=6379; unset($CONFIG['redis']['password']); $CONFIG['mail_smtphost']='127.0.0.1'; $CONFIG['mail_smtpport']=1; $CONFIG['mail_smtpauth']=false; file_put_contents('/var/www/html/config/config.php','<?php'.PHP_EOL.'$CONFIG = '.var_export($CONFIG,true).';'.PHP_EOL);"
 helper=extracted/'nextcloud'/'restore-config.php';helper.write_text(php);os.chmod(helper,0o644)
 namespace_uid=None;pod_uid=None
 try:
  namespace_uid=create_restore_namespace(ns)
  save(path/'restore-attempt.json',{'namespace':name,'namespaceUid':namespace_uid,'state':'CREATED','companyId':cid})
  kubectl('create','-f','-',input=json.dumps({'apiVersion':'v1','kind':'List','items':[secret,deny]}),text=True,capture_output=True)
  pod['metadata']['ownerReferences']=[{'apiVersion':'v1','kind':'Namespace','name':name,'uid':namespace_uid}]
  created=kubectl('create','-f','-','-o','json',input=json.dumps(pod),text=True,capture_output=True)
  pod_uid=owned_restore_pod(json.loads(created.stdout),name,namespace_uid)
  save(path/'restore-attempt.json',{'namespace':name,'namespaceUid':namespace_uid,'podUid':pod_uid,'state':'POD_CREATED','companyId':cid})
  kubectl('-n',name,'wait','--for=condition=Ready','pod/restore','--timeout=180s',capture_output=True)
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
  # The approved Alpine image provides su; preserve the mapped www-data identity.
  status=kubectl('-n',name,'exec','restore','-c','app','--','su','-s','/bin/sh','www-data','-c',
   'test "$(id -u)" = 33 && test "$(id -g)" = 33 && cd /var/www/html && exec php /var/www/html/occ status --output=json',capture_output=True,text=True)
  value=json.loads(status.stdout)
  if value.get('installed') is not True or value.get('needsDbUpgrade') is True:raise RuntimeError('Restored Nextcloud is not ready')
  counts=kubectl('-n',name,'exec','restore','-c','db','--','psql','-U','libresign','-d','libresign','-At','-c',"SELECT json_build_object('users',(SELECT count(*) FROM oc_users),'signingTables',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'oc_libresign%'),'appSettings',(SELECT count(*) FROM oc_appconfig));",capture_output=True,text=True)
  evidence.update({'state':'DAM_DATABASE_APPLICATION_RESTORE_PASS','nextcloudVersion':value.get('version'),'databaseCounts':json.loads(counts.stdout),'isolated':True,'publicMailSent':False})
  save(path/'restore-evidence.json',evidence);print(json.dumps(evidence),flush=True)
 finally:
  # Only this probe's exact namespace can be deleted; the five live namespaces are never targeted.
  if namespace_uid is not None:
   receipt={'namespace':name,'namespaceUid':namespace_uid,'podUid':pod_uid,'state':'CLEANING','companyId':cid,'cleanupSequence':[]}
   def progress(state):
    receipt['cleanupSequence'].append(state);save(path/'restore-attempt.json',receipt)
   cleanup_restore_namespace(name,namespace_uid,pod_uid=pod_uid,progress=progress)
   receipt['cleanupSequence'].append('NAMESPACE_ABSENT');receipt['state']='CLEANED';save(path/'restore-attempt.json',receipt)

if __name__=='__main__':
 from KubernetesBackupSignals import install_signal_handlers
 install_signal_handlers()
 p=argparse.ArgumentParser();p.add_argument('path',type=Path);args=p.parse_args();target=args.path.resolve()
 if not target.is_relative_to(ROOT) or len(target.relative_to(ROOT).parts)!=3 or not target.name.startswith('restore-'):raise RuntimeError('Expected isolated restore directory')
 main(target)

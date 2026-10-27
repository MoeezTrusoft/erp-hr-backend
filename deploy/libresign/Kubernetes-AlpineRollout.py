#!/usr/bin/env python3
"""Company-by-company immutable runtime cutover with retained rollback snapshots."""
import argparse,base64,copy,hashlib,json,os,re,shlex,subprocess,time
from pathlib import Path
from KubernetesBackupLock import backup_run_lock
from KubernetesBackupSignals import install_signal_handlers
from RegistryAliasProof import verify_live
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s');TOOLS=Path(__file__).resolve().parent
CANDIDATE='localhost:5000/erp-build/libresign-alpine@sha256:9adaf20f7219646396adaf0d89acd1fcb1386b2d17b164eb791730d8d5b1b08f'
ORIGINAL='docker.io/library/recruitment-libresign@sha256:0916c08b74f8ba89d3e36afee15e4c39fb28f1c3865c9d31203e28bfe57db097'
COMPANIES={'homenet':'8ff0533b-62f6-4be9-a78e-69adf49e00bc','joc':'8f4a526f-d45b-4da2-b772-d6682e849812','trusoft':'40314ef4-0a81-4390-b631-b3ad3f21f523','boc':'14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','homevision':'61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'}
SETTINGS={'signature_engine':'PhpNative','java_path':'/native-disabled/java_path','pdftk_path':'/native-disabled/pdftk_path','jsignpdf_path':'/native-disabled/jsignpdf_path'}
def run(*args,**kw):kw.setdefault('timeout',45);return subprocess.run(list(args),check=True,capture_output=True,**kw)
def kube(*args,**kw):return run('kubectl',*args,**kw)
def save(path,value):
 temporary=path.with_suffix('.partial');temporary.write_text(json.dumps(value,indent=2));os.chmod(temporary,0o600);os.replace(temporary,path)
def clean(obj):
 value=copy.deepcopy(obj);value.pop('status',None)
 for key in ['creationTimestamp','generation','managedFields','resourceVersion','uid']:value['metadata'].pop(key,None)
 value['metadata'].get('annotations',{}).pop('kubectl.kubernetes.io/last-applied-configuration',None)
 return value
def web_container(image=CANDIDATE):
 return {'name':'web','image':image,'imagePullPolicy':'Always','command':['/bin/sh','-ec','mkdir -p /var/lib/nginx/tmp /var/lib/nginx/logs; exec nginx -e /dev/stderr -g "daemon off;"'],
  'securityContext':{'runAsNonRoot':True,'runAsUser':33,'runAsGroup':33,'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},
  'resources':{'requests':{'cpu':'1m','memory':'32Mi'},'limits':{'cpu':'250m','memory':'128Mi'}},
  'volumeMounts':[{'name':'nextcloud','mountPath':'/var/www/html','readOnly':True},{'name':'nginx-run','mountPath':'/run/nginx'},{'name':'nginx-state','mountPath':'/var/lib/nginx'}],
  'readinessProbe':{'tcpSocket':{'port':8080},'periodSeconds':5}}
def render(before):
 rows=copy.deepcopy(before['items']);by={(r['kind'],r['metadata']['name']):r for r in rows}
 app=by['Deployment','app'];cron=by['Deployment','cron'];service=by['Service','app'];policy=by['NetworkPolicy','host-proxy']
 for deploy in [app,cron]:
  containers=deploy['spec']['template']['spec']['containers']
  if len(containers)!=1 or containers[0]['image']!=ORIGINAL:raise RuntimeError('Unexpected original workload; inspect before planning')
  containers[0]['image']=CANDIDATE;containers[0]['imagePullPolicy']='Always'
 pod=app['spec']['template']['spec'];php=pod['containers'][0]
 for key in ['readinessProbe','startupProbe']:php[key]['httpGet']['port']=8080
 pod.setdefault('securityContext',{}).update({'fsGroup':33,'fsGroupChangePolicy':'OnRootMismatch','seccompProfile':{'type':'RuntimeDefault'}})
 pod['volumes'] += [{'name':'nginx-run','emptyDir':{'sizeLimit':'16Mi'}},{'name':'nginx-state','emptyDir':{'sizeLimit':'128Mi'}}]
 pod['containers'].append(web_container())
 if service['spec']['ports']!=[{'port':80,'protocol':'TCP','targetPort':80}]:raise RuntimeError('Unexpected application Service ports')
 service['spec']['ports'][0]['targetPort']=8080
 for rule in policy['spec']['ingress']:
  if rule.get('ports')!=[{'port':80,'protocol':'TCP'}]:raise RuntimeError('Unexpected host ingress boundary')
  rule['ports']=[{'port':8080,'protocol':'TCP'}]
 return {'apiVersion':'v1','kind':'List','items':rows}
def occ(ns,*args,check=True):
 if not all(isinstance(a,str) and '\0' not in a for a in args):raise RuntimeError('Invalid configuration argument')
 return subprocess.run(['kubectl','-n',ns,'exec','deployment/app','-c','app','--','su','-s','/bin/sh','www-data','-c',shlex.join(['php','occ',*args])],capture_output=True,text=True,check=check,timeout=60)
def gates():
 class KubeRead:
  def get(self,kind,name=None,namespace=None,selector=None):return json.loads(kube('get',kind,*([name] if name else []),*(['-n',namespace] if namespace else []),*(['-l',selector] if selector else []),'-o','json').stdout)
 proof=verify_live(KubeRead(),json.loads((Path('/opt/erp-cicd/trugit-k8s-ci-20261023/registry/receipts/qualification.json')).read_text()))
 scan=json.loads((ROOT/'alpine-candidate-2c12f7c79ecc9bcc/scan-results/receipt.json').read_text())
 if not scan['complete']['scansComplete'] or not scan['complete']['coverageComplete'] or not scan['complete']['clean']:raise RuntimeError('Exact candidate scan has not passed')
 if len(scan['summary'])!=1 or scan['summary'][0]['image'].split('@')[-1]!=CANDIDATE.split('@')[-1]:raise RuntimeError('Scan identity mismatch')
 index=json.loads((ROOT/'backups/first-dam-backup-20261023.json').read_text())
 if index['state']!='FIVE_COMPANY_DAM_RESTORE_VERIFIED':raise RuntimeError('Five-company DAM restore receipt is required')
 native=json.loads((Path(index['companies']['homenet']['restorePath'])/'native-signing-evidence.json').read_text())
 web=json.loads((ROOT/'alpine-candidate-2c12f7c79ecc9bcc/web-container-qualification.json').read_text())
 if web.get('state')!='EXACT_NONROOT_READONLY_WEB_READY' or web.get('image')!=CANDIDATE or web.get('webContainerSha256')!=hashlib.sha256(json.dumps(web_container(),sort_keys=True).encode()).hexdigest():raise RuntimeError('Exact production web container qualification required')
 if native.get('webStack')!='NGINX_FPM_READONLY_NONROOT_SIDECAR':raise RuntimeError('Native acceptance must use production web sidecar')
 if native.get('state')!='NATIVE_SIGNING_ISOLATED_PASS' or native.get('image')!=CANDIDATE or native.get('cryptographicSignature')!='VALID_WHOLE_DOCUMENT':raise RuntimeError('Exact candidate native signing receipt required')
 review=json.loads((ROOT/'alpine-candidate-2c12f7c79ecc9bcc/advisory-review.json').read_text())
 if review.get('state')!='REVIEWED_RETAINED_FINDINGS' or review.get('image')!=CANDIDATE:raise RuntimeError('Retained findings need explicit source applicability review')
 run('python3',str(TOOLS/'Kubernetes-BackupSchedule.py'),'--check')
 return {'registry':proof,'scan':'SCANNED_IN_KUBERNETES','native':'VALID_WHOLE_DOCUMENT','retainedFindings':review['findings']}
def snapshot(name,folder):
 ns='sign-'+name;items=[]
 for kind,key in [('Deployment','app'),('Deployment','cron'),('Service','app'),('NetworkPolicy','host-proxy')]:items.append(clean(json.loads(kube('-n',ns,'get',kind,key,'-o','json').stdout)))
 before={'apiVersion':'v1','kind':'List','items':items};desired=render(before)
 save(folder/'before.json',before);save(folder/'desired.json',desired)
 settings={}
 for key in SETTINGS:
  value=occ(ns,'config:app:get','libresign',key,check=False)
  if value.returncode not in [0,1]:raise RuntimeError('Failed to read prior signing setting')
  settings[key]={'present':value.returncode==0,'value':value.stdout.strip()}
 save(folder/'settings-before.json',settings)
 baseline={'instanceId':occ(ns,'config:system:get','instanceid').stdout.strip(),'mail':{}}
 for key in ['mail_smtphost','mail_smtpport','mail_smtpname','mail_from_address','mail_domain']:
  value=occ(ns,'config:system:get',key,check=False);baseline['mail'][key]=value.stdout.strip() if value.returncode==0 else None
 user=json.loads(occ(ns,'user:info','erp-recruitment-'+COMPANIES[name],'--output=json').stdout)
 if 'admin' in user.get('groups',[]) or 'recruitment-signers' not in user.get('groups',[]):raise RuntimeError('Expected isolated non-admin requestor')
 save(folder/'baseline.json',baseline)
 kube('apply','-f',str(folder/'desired.json'),'--dry-run=server','-o','name')
 return before

def scale(ns,name,count):
 kube('-n',ns,'scale','deployment/'+name,'--replicas='+str(count))
 if count:kube('-n',ns,'rollout','status','deployment/'+name,'--timeout=240s',timeout=270)
 else:
  for _ in range(90):
   if not json.loads(kube('-n',ns,'get','pod','-l','app='+name,'-o','json').stdout)['items']:return
   time.sleep(2)
  raise RuntimeError('Workload drain deadline')
def https_check(name):
 cid=COMPANIES[name];names=list(COMPANIES);foreign=COMPANIES[names[(names.index(name)+1)%len(names)]]
 source=Path('/home/erp_trusoft/recruitment-libresign-companies')
 payload={'companyId':cid,'baseUrl':'https://erp.trusoft.ai/signing/'+cid,'username':'erp-recruitment-'+cid,
  'password':(source/cid/'.secrets'/(cid+'.app-password')).read_text().strip(),
  'foreignUsername':'erp-recruitment-'+foreign,'foreignPassword':(source/foreign/'.secrets'/(foreign+'.app-password')).read_text().strip(),
  'clientSource':base64.b64encode((TOOLS/'libresignClient.mjs').read_bytes()).decode(),
  'pdf':base64.b64encode((source/cid/'.runtime/synthetic-offer.pdf').read_bytes()).decode()}
 data=json.dumps(payload)
 if len(data.encode())>=60000:raise RuntimeError('Test input exceeds verified exec transfer bound')
 result=kube('-n','erp-svc','exec','-i','deployment/erp-hr-backend','-c','hr','--','node','--input-type=module','-e',(TOOLS/'Check-CompanyHttps.mjs').read_text(),input=data,text=True,timeout=240)
 return json.loads(result.stdout.strip().splitlines()[-1])
def restore_settings(ns,settings):
 for key,item in settings.items():
  if item['present']:occ(ns,'config:app:set','libresign',key,'--value',item['value'])
  else:occ(ns,'config:app:delete','libresign',key)
def rollback(name,folder):
 install_signal_handlers(defer=True);ns='sign-'+name
 save(folder/'state.json',{'state':'ROLLBACK_IN_PROGRESS','company':name,'image':ORIGINAL})
 before=json.loads((folder/'before.json').read_text());paused=copy.deepcopy(before)
 original_cron=next(x for x in before['items'] if x['kind']=='Deployment' and x['metadata']['name']=='cron')['spec']['replicas']
 next(x for x in paused['items'] if x['kind']=='Deployment' and x['metadata']['name']=='cron')['spec']['replicas']=0
 save(folder/'rollback-paused.json',paused);kube('apply','-f',str(folder/'rollback-paused.json'))
 kube('-n',ns,'rollout','status','deployment/app','--timeout=300s',timeout=330)
 restore_settings(ns,json.loads((folder/'settings-before.json').read_text()));scale(ns,'cron',original_cron)
 acceptance=https_check(name);save(folder/'rollback-acceptance.json',acceptance)
 original_manifest=folder/'recovery-manifest-before.json'
 if original_manifest.exists():save(ROOT/'companies'/COMPANIES[name]/'manifest.json',json.loads(original_manifest.read_text()))
 save(folder/'state.json',{'state':'ROLLED_BACK_VERIFIED','company':name,'image':ORIGINAL,'publicMailSent':False})
def main(name,action):
 os.umask(0o077);folder=ROOT/'alpine-rollout'/name;ns='sign-'+name
 with backup_run_lock(ROOT/'backups'):
  if action=='rollback':rollback(name,folder);return
  evidence=gates()
  review=json.loads((ROOT/'alpine-candidate-2c12f7c79ecc9bcc/advisory-review.json').read_text())
  source=Path('/var/lib/erp-recruitment-signing')/COMPANIES[name]/'nextcloud'
  for relative,expected_hash in review['sourceSha256'].items():
   path=source/relative
   if not path.resolve().is_relative_to(source) or hashlib.sha256(path.read_bytes()).hexdigest()!=expected_hash:raise RuntimeError('Application source changed since advisory review')
  if action=='plan':
   folder.mkdir(parents=True,exist_ok=False,mode=0o700);snapshot(name,folder)
   save(folder/'recovery-manifest-before.json',json.loads((ROOT/'companies'/COMPANIES[name]/'manifest.json').read_text()))
   save(folder/'state.json',{'state':'PREPARED_SERVER_DRY_RUN_PASS','company':name,'image':CANDIDATE,'gates':evidence});print(json.dumps({'company':name,'state':'PREPARED_SERVER_DRY_RUN_PASS'}));return
  before=json.loads((folder/'before.json').read_text())
  state=json.loads((folder/'state.json').read_text())
  if state['state']!='PREPARED_SERVER_DRY_RUN_PASS':raise RuntimeError('Inspect existing rollout outcome before repeating')
  for expected in before['items']:
   actual=clean(json.loads(kube('-n',ns,'get',expected['kind'],expected['metadata']['name'],'-o','json').stdout))
   if actual!=expected:raise RuntimeError('Live resource changed since reviewed plan: '+expected['kind']+'/'+expected['metadata']['name'])
  mutated=False
  try:
   save(folder/'state.json',{'state':'APPLYING','company':name,'image':CANDIDATE});mutated=True;scale(ns,'cron',0)
   for key,value in SETTINGS.items():occ(ns,'config:app:set','libresign',key,'--value',value)
   desired=json.loads((folder/'desired.json').read_text());paused=copy.deepcopy(desired)
   next(x for x in paused['items'] if x['kind']=='Deployment' and x['metadata']['name']=='cron')['spec']['replicas']=0
   save(folder/'apply-paused.json',paused);kube('apply','-f',str(folder/'apply-paused.json'))
   kube('-n',ns,'rollout','status','deployment/app','--timeout=300s',timeout=330)
   status=json.loads(occ(ns,'status','--output=json').stdout)
   if not status.get('installed') or status.get('maintenance') or status.get('needsDbUpgrade'):raise RuntimeError('Candidate application status failed')
   baseline=json.loads((folder/'baseline.json').read_text())
   if occ(ns,'config:system:get','instanceid').stdout.strip()!=baseline['instanceId']:raise RuntimeError('Company instance identity changed')
   for key,value in baseline['mail'].items():
    actual=occ(ns,'config:system:get',key,check=False)
    if (actual.stdout.strip() if actual.returncode==0 else None)!=value:raise RuntimeError('Company sender configuration changed')
   result=https_check(name);save(folder/'https-acceptance.json',result)
   scale(ns,'cron',1)
   # Record actual content hashes so later review can bind the live PHP tree.
   version=kube('-n',ns,'exec','deployment/app','-c','app','--','php','-r','echo PHP_VERSION;',text=True).stdout
   manifest=json.loads((folder/'recovery-manifest-before.json').read_text());replacements={(x['kind'],x['metadata']['name']):x for x in desired['items']}
   manifest['items']=[replacements.get((x['kind'],x['metadata']['name']),x) for x in manifest['items']]
   save(ROOT/'companies'/COMPANIES[name]/'manifest.json',manifest)
   save(folder/'state.json',{'state':'DEPLOYED_HTTPS_ACCEPTANCE_PASS','company':name,'image':CANDIDATE,'phpVersion':version.strip(),'publicMailSent':False,'gates':evidence})
   print(json.dumps({'company':name,'state':'DEPLOYED_HTTPS_ACCEPTANCE_PASS','image':CANDIDATE}),flush=True)
  except BaseException:
   if mutated:rollback(name,folder)
   raise
if __name__=='__main__':
 install_signal_handlers();p=argparse.ArgumentParser();p.add_argument('action',choices=['plan','apply','rollback']);p.add_argument('--company',choices=COMPANIES,required=True);a=p.parse_args();main(a.company,a.action)

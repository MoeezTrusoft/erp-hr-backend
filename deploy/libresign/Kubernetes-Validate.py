#!/usr/bin/env python3
"""Read-only runtime isolation and preserved HR binding checks; never sends mail."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time

parser=argparse.ArgumentParser();parser.add_argument('--expected-image');args=parser.parse_args()

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('Kubernetes-Recover.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def kube(*args):
    result = subprocess.run(['kubectl', *args], check=True, capture_output=True, text=True, timeout=45)
    return result.stdout.strip()


def connect(namespace, host, port, expected):
    # No credentials. A working company-local connection is the control for each denial.
    code = '$s=@fsockopen($argv[1],(int)$argv[2],$e,$m,2);if($s)fclose($s);echo $s ? "OPEN" : "BLOCKED";'
    actual = kube('-n', namespace, 'exec', 'deployment/app', '-c', 'app', '--', 'php', '-r', code, host, str(port))
    if actual != expected:
        raise RuntimeError('Namespace isolation check failed for ' + namespace)


report = {'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'companies': []}
names = list(recovery.COMPANIES)
for index, name in enumerate(names):
    ns = 'sign-' + name
    cid = recovery.COMPANIES[name]
    pods = json.loads(kube('-n', ns, 'get', 'pods', '-o', 'json'))['items']
    for app in ('app', 'cron', 'db', 'redis'):
        selected = [p for p in pods if p['metadata']['labels'].get('app') == app]
        if len(selected) != 1 or not all(s.get('ready') for s in selected[0]['status'].get('containerStatuses', [])):
            raise RuntimeError('Required service is not ready: ' + ns + '/' + app)
    images={p['metadata']['labels']['app']:{c['name']:c['image'] for c in p['spec']['containers']} for p in pods if p['metadata']['labels'].get('app') in ('app','cron')}
    if args.expected_image and any(image!=args.expected_image for containers in images.values() for image in containers.values()):
        raise RuntimeError('Company app or cron image differs from accepted candidate')
    status=json.loads(kube('-n',ns,'exec','deployment/app','-c','app','--','su','-s','/bin/sh','www-data','-c','php occ status --output=json'))
    if not status.get('installed') or status.get('maintenance') or status.get('needsDbUpgrade'):raise RuntimeError('Application runtime status is not healthy')
    own_redis=kube('-n',ns,'get','service','redis','-o','jsonpath={.spec.clusterIP}')
    connect(ns,own_redis,6379,'OPEN')
    own_ip = kube('-n', ns, 'get', 'service', 'db', '-o', 'jsonpath={.spec.clusterIP}')
    foreign_ns = 'sign-' + names[(index + 1) % len(names)]
    foreign_ip = kube('-n', foreign_ns, 'get', 'service', 'db', '-o', 'jsonpath={.spec.clusterIP}')
    foreign_redis = kube('-n', foreign_ns, 'get', 'service', 'redis', '-o', 'jsonpath={.spec.clusterIP}')
    connect(ns, own_ip, 5432, 'OPEN')
    connect(ns, foreign_ip, 5432, 'BLOCKED')
    connect(ns, foreign_redis, 6379, 'BLOCKED')
    claims = json.loads(kube('-n', ns, 'get', 'pvc', '-o', 'json'))['items']
    if len(claims) != 3 or any(p['status']['phase'] != 'Bound' for p in claims):
        raise RuntimeError('Company persistence is not fully bound')
    verified = json.loads((recovery.ROOT / cid / 'copy-verified.json').read_text())
    if len(verified['volumes']) != 3:
        raise RuntimeError('Missing copy verification evidence')
    report['companies'].append({'name': name, 'companyId': cid, 'appDatabaseRedisReady': True,'cronReady':True,'images':images,'nextcloudVersion':status['version'],
        'ownDatabaseReachable': True,'ownRedisReachable':True, 'foreignDatabaseBlocked': True, 'foreignRedisBlocked': True,
        'verifiedOriginalCopies': True, 'boundPersistenceVolumes': 3})
    print('PASS ' + name + ': runtime, retained persistence, and network isolation', flush=True)

javascript = r"""
const fs=require('fs');
(async()=>{
 const path=process.env.HR_LIBRESIGN_CONFIG_FILE;
 if(!path)throw Error('Missing company signing configuration');
 const entries=JSON.parse(fs.readFileSync(path,'utf8'));
 const expected=['40314ef4-0a81-4390-b631-b3ad3f21f523','14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'];
 if(Object.keys(entries).sort().join()!==expected.sort().join())throw Error('Unexpected company bindings');
 const result=[];
 for(const id of expected){
  const c=entries[id];
  if(c.baseUrl!=='https://erp.trusoft.ai/signing/'+id||c.username!=='erp-recruitment-'+id)throw Error('Company binding mismatch');
  const password=fs.readFileSync(c.appPasswordFile,'utf8').trim();
  const auth='Basic '+Buffer.from(c.username+':'+password).toString('base64');
  const response=await fetch(c.baseUrl+'/ocs/v2.php/cloud/user?format=json',{headers:{Authorization:auth,'OCS-APIRequest':'true',Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  if(!response.ok||body.ocs?.data?.id!==c.username)throw Error('Company authentication failed');
  result.push({companyId:id,authenticated:true});
 }
 console.log(JSON.stringify(result));
})().catch(()=>{console.error('HR company binding verification failed; no credential details emitted');process.exitCode=1;});
"""
report['hrProductionBindings'] = json.loads(kube('-n', 'erp-svc', 'exec', 'deployment/erp-hr-backend', '-c','hr','--', 'node', '-e', javascript))
recovery.require_stopped()
report['dockerRemainsStopped'] = True
report['additionalExternalMailSent'] = False
recovery.save(Path('/opt/erp-cicd/recruitment-signing-k8s/runtime-validation.json'), report)
print('PASS three HR company bindings authenticated; Docker remains stopped', flush=True)

import importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import nullcontext
from unittest.mock import patch
import sys
TOOLS=Path(sys.argv.pop(1)) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]/'deploy/libresign'
sys.path.insert(0,str(TOOLS));spec=importlib.util.spec_from_file_location('rollout',TOOLS/'Kubernetes-AlpineRollout.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture():
 items=[]
 for name in ['app','cron']:
  c={'name':name,'image':m.ORIGINAL,'resources':{'requests':{'cpu':'100m','memory':'256Mi'}},'volumeMounts':[{'name':'nextcloud','mountPath':'/var/www/html'},{'name':'runtime','mountPath':'/run/secrets'}]}
  if name=='app':
   for key in ['readinessProbe','startupProbe']:c[key]={'httpGet':{'path':'/status.php','port':80}}
  items.append({'kind':'Deployment','metadata':{'name':name,'namespace':'sign-homenet'},'spec':{'replicas':1,'template':{'spec':{'containers':[c],'volumes':[{'name':'nextcloud','persistentVolumeClaim':{'claimName':'nextcloud'}},{'name':'runtime','secret':{'secretName':'runtime'}}]}}}})
 items+=[{'kind':'Service','metadata':{'name':'app','namespace':'sign-homenet'},'spec':{'clusterIP':'10.43.0.1','ports':[{'port':80,'protocol':'TCP','targetPort':80}]}},{'kind':'NetworkPolicy','metadata':{'name':'host-proxy','namespace':'sign-homenet'},'spec':{'ingress':[{'from':[{'ipBlock':{'cidr':'127.0.0.1/32'}}],'ports':[{'port':80,'protocol':'TCP'}]}]}}]
 return {'apiVersion':'v1','kind':'List','items':items}
class CutoverTests(unittest.TestCase):
 def test_empty_or_shell_significant_setting_roundtrips_as_one_argument(self):
  import shlex
  for value in ['', '/opt/signing runtime/file', '$(not-executed); literal']:
   with patch.object(m.subprocess,'run') as execute:
    m.occ('sign-homenet','config:app:set','libresign','java_path','--value',value)
    command=execute.call_args.args[0][-1]
    self.assertEqual(shlex.split(command),['php','occ','config:app:set','libresign','java_path','--value',value])
 def test_plan_preserves_identity_storage_and_sender_mounts(self):
  before=fixture();original=json.dumps(before);after=m.render(before);self.assertEqual(json.dumps(before),original)
  app=after['items'][0]['spec']['template']['spec'];self.assertEqual(app['containers'][0]['volumeMounts'],before['items'][0]['spec']['template']['spec']['containers'][0]['volumeMounts'])
  web=app['containers'][1];self.assertTrue(web['securityContext']['readOnlyRootFilesystem']);self.assertFalse(any(x['name']=='runtime' for x in web['volumeMounts']));self.assertTrue(web['volumeMounts'][0]['readOnly'])
  self.assertEqual(after['items'][2]['spec']['clusterIP'],'10.43.0.1');self.assertEqual(after['items'][2]['spec']['ports'][0]['targetPort'],8080)
  self.assertEqual({x['kind'] for x in after['items']},{'Deployment','Service','NetworkPolicy'})
 def test_refuses_changed_original_image_or_unexpected_network_port(self):
  for kind in ['image','port']:
   before=fixture()
   if kind=='image':before['items'][0]['spec']['template']['spec']['containers'][0]['image']='unexpected'
   else:before['items'][2]['spec']['ports'][0]['port']=9000
   with self.assertRaises(RuntimeError):m.render(before)
 def test_failed_acceptance_restores_original_before_resuming_cron(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);folder=root/'alpine-rollout'/'homenet';folder.mkdir(parents=True);before=fixture();events=[]
   (root/'alpine-candidate-2c12f7c79ecc9bcc').mkdir();m.save(root/'alpine-candidate-2c12f7c79ecc9bcc/advisory-review.json',{'sourceSha256':{}})
   m.save(folder/'before.json',before);m.save(folder/'desired.json',m.render(before));m.save(folder/'settings-before.json',{'signature_engine':{'present':True,'value':'JSignPdf'}});m.save(folder/'baseline.json',{'instanceId':'original','mail':{}});m.save(folder/'state.json',{'state':'PREPARED_SERVER_DRY_RUN_PASS'})
   def kube(*args,**kw):
    if 'get' in args:
     pos=args.index('get');row=next(x for x in before['items'] if x['kind']==args[pos+1] and x['metadata']['name']==args[pos+2]);return SimpleNamespace(stdout=json.dumps(row).encode())
    if args[:2]==('apply','-f'):
     value=json.loads(Path(args[2]).read_text());events.append(('apply',value['items'][0]['spec']['template']['spec']['containers'][0]['image'],value['items'][1]['spec']['replicas']))
    return SimpleNamespace(stdout=b'')
   def occ(ns,*args,**kw):
    events.append(('occ',args));return SimpleNamespace(returncode=0,stdout=json.dumps({'installed':True,'maintenance':False,'needsDbUpgrade':False}) if args[0]=='status' else 'original')
   def check(name):
    if not any(e[0]=='apply' and e[1]==m.ORIGINAL for e in events):raise RuntimeError('Synthetic HTTPS acceptance failure')
    return {'state':'HTTPS_PROVIDER_ACCEPTANCE_PASS'}
   with patch.object(m,'ROOT',root),patch.object(m,'gates',return_value={}),patch.object(m,'backup_run_lock',return_value=nullcontext()),patch.object(m,'kube',side_effect=kube),patch.object(m,'occ',side_effect=occ),patch.object(m,'https_check',side_effect=check),patch.object(m,'scale',side_effect=lambda ns,n,c:events.append(('scale',n,c))),patch.object(m,'install_signal_handlers'):
    with self.assertRaisesRegex(RuntimeError,'Synthetic HTTPS'):m.main('homenet','apply')
   self.assertEqual(json.loads((folder/'state.json').read_text())['state'],'ROLLED_BACK_VERIFIED')
   restore=next(i for i,e in enumerate(events) if e[0]=='apply' and e[1]==m.ORIGINAL);resume=next(i for i,e in enumerate(events) if e==('scale','cron',1));self.assertLess(restore,resume)
   self.assertEqual(events[restore][2],0)
if __name__=='__main__':unittest.main()

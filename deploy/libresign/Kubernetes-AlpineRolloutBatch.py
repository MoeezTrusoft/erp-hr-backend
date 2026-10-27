#!/usr/bin/env python3
"""Sequential rollout: a failed company halts all remaining changes."""
import json,os,subprocess
from pathlib import Path
ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s');os.umask(0o077)
def run(script,*args,timeout=1800):subprocess.run(['python3',str(ROOT/script),*args],check=True,timeout=timeout)
def main():
 receipt=json.loads((ROOT/'alpine-rollout/homenet/sink-signing-acceptance.json').read_text());assert receipt['state']=='PUBLIC_PREFIX_SINK_SIGNING_PASS' and receipt['cryptographicSignature']=='VALID_WHOLE_DOCUMENT'
 results={'homenet':receipt}
 for company in ['joc','trusoft','boc','homevision']:
  run('Kubernetes-AlpineRollout.py','plan','--company',company)
  run('Kubernetes-AlpineRollout.py','apply','--company',company)
  if company=='joc':run('Kubernetes-CompanySinkProbe.py','--company',company,timeout=900)
  else:
   checked=subprocess.run(['kubectl','-n','sign-'+company,'exec','-i','deployment/app','-c','app','--','php'],input=(ROOT/'Kubernetes-SmtpCheck.php').read_bytes(),capture_output=True,timeout=120)
   (ROOT/'alpine-rollout'/company/'smtp-acceptance.log').write_bytes(checked.stdout+checked.stderr)
   if checked.returncode:raise RuntimeError('Strict TLS SMTP acceptance failed; inspect protected receipt')
  state=json.loads((ROOT/'alpine-rollout'/company/'state.json').read_text());assert state['state']=='DEPLOYED_HTTPS_ACCEPTANCE_PASS';results[company]={'state':state['state'],'image':state['image'],'smtp':'SINK_SIGNING_PASS' if company=='joc' else 'STRICT_TLS_AUTH_PASS_NO_MAIL'}
  (ROOT/'alpine-rollout/batch-progress.json').write_text(json.dumps({'state':'IN_PROGRESS','companies':results},indent=2));print(json.dumps({'company':company,'state':'ACCEPTANCE_PASS'}),flush=True)
 (ROOT/'alpine-rollout/batch-progress.json').write_text(json.dumps({'state':'FIVE_COMPANY_RUNTIME_ACCEPTANCE_PASS','companies':results,'additionalPublicMailSent':False},indent=2));print('FIVE_COMPANY_RUNTIME_ACCEPTANCE_PASS',flush=True)
if __name__=='__main__':main()

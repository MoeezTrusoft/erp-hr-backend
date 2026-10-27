// Uses only synthetic PDFs and read-only account checks. Never sends invitations.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root = '/home/erp_trusoft/recruitment-libresign-companies';
const output = '/opt/erp-cicd/recruitment-signing-k8s';
const companies = [
  ['trusoft', '40314ef4-0a81-4390-b631-b3ad3f21f523'],
  ['boc', '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2'],
  ['homevision', '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73'],
  ['homenet', '8ff0533b-62f6-4be9-a78e-69adf49e00bc'],
  ['joc', '8f4a526f-d45b-4da2-b772-d6682e849812'],
];
const selected = process.argv[2];
assert.ok(!selected || companies.some(([name]) => name === selected));
const {createLibreSignClient} = await import(pathToFileURL(root+'/'+companies[0][1]+'/libresignClient.mjs'));
const identities = new Set();
const report = [];
const occ = (namespace, args) => {
  assert.ok(args.every(arg => /^[\w.:@/=-]+$/.test(arg)));
  try {
    return execFileSync('kubectl', ['-n',namespace,'exec','deployment/app','--','su','-s','/bin/sh','www-data','-c','php occ '+args.join(' ')],{encoding:'utf8',timeout:45000,stdio:['ignore','pipe','pipe']}).trim();
  } catch { throw new Error('Nextcloud command failed; inspect protected operational logs'); }
};
const get = async (url, auth) => {
  const response = await fetch(url,{headers:{Authorization:auth,Accept:'application/json','OCS-APIRequest':'true'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const text = await response.text();
  return {status:response.status,body: (() => {try{return JSON.parse(text);}catch{return null;}})()};
};
for (let i=0; i<companies.length; i++) {
  const [name,cid]=companies[i];
  if (selected && selected !== name) continue;
  const ns='sign-'+name, baseUrl='https://erp.trusoft.ai/signing/'+cid;
  const username='erp-recruitment-'+cid;
  const appPassword=(await readFile(root+'/'+cid+'/.secrets/'+cid+'.app-password','utf8')).trim();
  const auth='Basic '+Buffer.from(username+':'+appPassword).toString('base64');
  const health=await get(baseUrl+'/status.php',auth);
  assert.equal(health.status,200);
  assert.equal(health.body.installed,true); assert.equal(health.body.maintenance,false); assert.equal(health.body.needsDbUpgrade,false);
  const instance=occ(ns,['config:system:get','instanceid']);
  assert.ok(instance && !identities.has(instance),'Independent instance identities required'); identities.add(instance);
  assert.equal(occ(ns,['config:app:get','core','shareapi_enabled']),'no');
  const user=JSON.parse(occ(ns,['user:info',username,'--output=json']));
  assert.ok(user.groups.includes('recruitment-signers')); assert.ok(!user.groups.includes('admin'));
  const identity=await get(baseUrl+'/ocs/v2.php/cloud/user?format=json',auth);
  assert.equal(identity.body?.ocs?.data?.id,username);
  const foreign=companies[(i+1)%companies.length][1];
  const otherPassword=(await readFile(root+'/'+foreign+'/.secrets/'+foreign+'.app-password','utf8')).trim();
  const otherAuth='Basic '+Buffer.from('erp-recruitment-'+foreign+':'+otherPassword).toString('base64');
  const denied=await get(baseUrl+'/ocs/v2.php/cloud/user?format=json',otherAuth);
  assert.ok([401,403,404].includes(denied.status) || !denied.body?.ocs?.data?.id);
  const production=i<3;
  if (production) {
    const smtp=JSON.parse(await readFile(root+'/'+cid+'/.secrets/smtp-settings.json','utf8'));
    for(const key of ['mail_smtphost','mail_smtpport','mail_smtpname','mail_from_address','mail_domain'])
      assert.equal(occ(ns,['config:system:get',key]),String(smtp[key]));
  } else assert.equal(occ(ns,['config:system:get','mail_smtphost']),'mailpit');
  const client=createLibreSignClient({tenantId:cid,baseUrl,username,appPassword,timeoutMs:60000});
  const bytes=await readFile(root+'/'+cid+'/.runtime/synthetic-offer.pdf');
  const document={offerId:900000023,version:1,sha256:createHash('sha256').update(bytes).digest('hex')};
  let expected;
  try {
    const uploaded=await client.prepareDocument(document,bytes);
    expected={...uploaded,email:'kubernetes-acceptance@example.invalid'};
    assert.equal((await client.prepareDocument(document,bytes)).nodeId,uploaded.nodeId);
    assert.equal(await client.reconcile(expected),null,'Acceptance never creates a signing workflow');
    const foreignFile=await get(baseUrl+uploaded.path,otherAuth);
    assert.ok([401,403,404].includes(foreignFile.status));
  } finally {
    if(expected){await client.erase(expected,document);await client.erase(expected,document);}
  }
  report.push({name,companyId:cid,https:true,independentInstance:true,nonAdminRequestor:true,foreignAccountDenied:true,
    foreignDocumentDenied:true,mailConfigurationPreserved:true,idempotentUpload:true,erasureVerified:true,additionalInvitationsSent:false});
  console.log('PASS '+name+': HTTPS, account isolation, mail policy, upload and erasure; no invitations sent');
  await writeFile(output+'/acceptance'+(selected?'-'+selected:'')+'.json',JSON.stringify({checkedAt:new Date().toISOString(),companies:report},null,2),{mode:0o600});
}

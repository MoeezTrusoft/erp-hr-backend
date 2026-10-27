import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const cfg=JSON.parse(readFileSync(0,'utf8'));
const allowed=['40314ef4-0a81-4390-b631-b3ad3f21f523','14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','61b7eb53-ab6e-413f-9d9a-1ecf4e071e73','8ff0533b-62f6-4be9-a78e-69adf49e00bc','8f4a526f-d45b-4da2-b772-d6682e849812'];
assert.ok(allowed.includes(cfg.companyId));assert.equal(cfg.baseUrl,'https://erp.trusoft.ai/signing/'+cfg.companyId);
const {createLibreSignClient}=await import('data:text/javascript;base64,'+cfg.clientSource);
const auth='Basic '+Buffer.from(cfg.username+':'+cfg.password).toString('base64');
const foreignAuth='Basic '+Buffer.from(cfg.foreignUsername+':'+cfg.foreignPassword).toString('base64');
const get=async(path,authorization=auth)=>{const r=await fetch(cfg.baseUrl+path,{headers:{Authorization:authorization,'OCS-APIRequest':'true',Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(30000)});return {status:r.status,text:await r.text()};};
const health=await get('/status.php');assert.equal(health.status,200);const status=JSON.parse(health.text);assert.equal(status.installed,true);assert.equal(status.maintenance,false);assert.equal(status.needsDbUpgrade,false);
const who=await get('/ocs/v2.php/cloud/user?format=json');assert.equal(JSON.parse(who.text).ocs?.data?.id,cfg.username);
const foreign=await get('/ocs/v2.php/cloud/user?format=json',foreignAuth);assert.ok([401,403,404].includes(foreign.status)||!JSON.parse(foreign.text).ocs?.data?.id);
for(const path of ['/config/config.php','/data/.ocdata','/lib/base.php'])assert.equal((await get(path)).status,404);
const client=createLibreSignClient({tenantId:cfg.companyId,baseUrl:cfg.baseUrl,username:cfg.username,appPassword:cfg.password,timeoutMs:60000});
const bytes=Buffer.from(cfg.pdf,'base64');const document={offerId:900000023,version:2,sha256:createHash('sha256').update(bytes).digest('hex')};let expected;
try{const uploaded=await client.prepareDocument(document,bytes);expected={...uploaded,email:'kubernetes-acceptance@example.invalid'};assert.equal((await client.prepareDocument(document,bytes)).nodeId,uploaded.nodeId);assert.equal(await client.reconcile(expected),null);assert.ok([401,403,404].includes((await get(uploaded.path,foreignAuth)).status));}
finally{if(expected){await client.erase(expected,document);await client.erase(expected,document);}}
console.log(JSON.stringify({state:'HTTPS_PROVIDER_ACCEPTANCE_PASS',companyId:cfg.companyId,https:true,foreignAccountDenied:true,foreignDocumentDenied:true,protectedPathsDenied:true,idempotentUpload:true,erasure:true,publicInvitationsSent:false}));

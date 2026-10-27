// Remove only the three documented setup fixtures before restarting reminders.
// Delivery evidence is retained; no invitation or other message is sent.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root='/home/erp_trusoft/recruitment-libresign-companies';
const companies=[
 ['40314ef4-0a81-4390-b631-b3ad3f21f523','Trusoft','recruitment@trusoft.ai'],
 ['14d8c7b1-194d-4e35-b058-b9cb9aa9fba2','BOC','recruitment@blazeoptics.pk'],
 ['61b7eb53-ab6e-413f-9d9a-1ecf4e071e73','HomeVision','recruitment@emgdigital.pk'],
];
const {createLibreSignClient}=await import(pathToFileURL(root+'/'+companies[0][0]+'/libresignClient.mjs'));
const report=[];
for(const [cid,name,email] of companies){
 const folder=root+'/'+cid;
 const j=JSON.parse(await readFile(folder+'/.runtime/setup-delivery-journal.json','utf8'));
 assert.equal(j.document.offerId,900000002); assert.equal(j.document.version,1);
 assert.match(j.document.sha256,/^[a-f0-9]{64}$/);
 assert.equal(j.expected.name,'LibreSign setup test - '+name+' - ERP-SETUP-20261022-001');
 assert.equal(j.expected.email,email);
 const username='erp-recruitment-'+cid;
 const client=createLibreSignClient({tenantId:cid,username,baseUrl:'https://erp.trusoft.ai/signing/'+cid,
  appPassword:(await readFile(folder+'/.secrets/'+cid+'.app-password','utf8')).trim(),timeoutMs:60000});
 const current=await client.reconcile(j.expected);
 if(current)assert.equal(current.fileId,j.fileId,'Only the exact recorded setup workflow may be erased');
 await client.erase(j.expected,j.document);
 report.push({companyId:cid,setupWorkflowId:j.fileId,erased:true,additionalMailSent:false});
 console.log('PASS '+name+': recorded setup-only workflow erased; delivery evidence retained');
}
await writeFile('/opt/erp-cicd/recruitment-signing-k8s/setup-cleanup.json',JSON.stringify({checkedAt:new Date().toISOString(),companies:report},null,2),{mode:0o600});

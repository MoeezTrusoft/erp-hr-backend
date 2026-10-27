import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createLibreSignClient} from './libresignClient.mjs';
// This smoke test may only use the isolated local Mailpit delivery configuration.
const mailHost=execFileSync('docker',['compose','exec','-T','--user','www-data','app','php','occ','config:system:get','mail_smtphost'],{encoding:'utf8',timeout:15000}).trim();
assert.equal(mailHost,'mailpit','Synthetic signing requires the local Mailpit configuration');
const loopback = service => { const value=execFileSync('docker',['compose','port',service,service==='app'?'80':'8025'],{encoding:'utf8',timeout:15000}).trim();assert.match(value,/^127\.0\.0\.1:\d+$/);return 'http://'+value; };
const base=loopback('app'), mailBase=loopback('mailpit'), api='/ocs/v2.php/apps/libresign/api/v1';
const email='libresign-smoke@example.invalid',tenantId=process.env.LIBRESIGN_SMOKE_TENANT||'00000000-0000-4000-8000-000000009999';
assert.match(tenantId,/^[0-9a-f-]{36}$/);
const username=process.env.LIBRESIGN_SMOKE_TENANT?'erp-recruitment-'+tenantId:'erp-recruitment';
const passwordFile=process.env.LIBRESIGN_SMOKE_TENANT?'.secrets/'+tenantId+'.app-password':'.secrets/integration_app_password';
const bytes=await readFile('.runtime/synthetic-offer.pdf'),sha256=createHash('sha256').update(bytes).digest('hex');
const client=createLibreSignClient({tenantId,baseUrl:base,username,appPassword:(await readFile(passwordFile,'utf8')).trim(),allowLocalHttp:true,timeoutMs:60000});
const document={offerId:900000001,version:1,sha256};
let expected;
const json=async(path,body)=>{
 const response=await fetch(base+api+path,{method:'POST',headers:{'OCS-APIRequest':'true','Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 const result=await response.json();
 if(!response.ok || result.ocs?.meta?.status!=='ok') throw new Error('Signing operation rejected: '+response.status+' '+JSON.stringify(result.ocs?.data).slice(0,500));
 return result.ocs.data;
};
try{
 let uploaded=await client.prepareDocument(document,bytes);expected={...uploaded,email,displayName:'Fictional LibreSign test signer'};
 if(await client.reconcile(expected)){await client.erase(expected,document);uploaded=await client.prepareDocument(document,bytes);expected={...uploaded,email,displayName:'Fictional LibreSign test signer'};}
 assert.equal((await client.prepareDocument(document,bytes)).nodeId,uploaded.nodeId);
 console.log('PASS checksum-bound idempotent DAV upload');
 let workflow=await client.requestSignature(expected);
 assert.equal((await client.reconcile(expected)).fileId,workflow.fileId);
 console.log('PASS request creation and read-only reconciliation');
 const mailbox=await fetch(mailBase+'/api/v1/messages').then(r=>r.json());
 let uuid;
 for(const message of mailbox.messages.filter(m=>m.To?.some(t=>t.Address===email))){
  const mail=await fetch(mailBase+'/api/v1/message/'+message.ID).then(r=>r.json());
  if(!String(mail.Text).includes(expected.name)) continue;
  uuid=String(mail.Text).match(/\/(?:index\.php\/)?apps\/libresign\/p\/sign\/([0-9a-f-]{36})/i)?.[1];
  if(uuid)break;
 }
 assert.ok(uuid,'Provider invitation did not include the synthetic signer link');
 console.log('PASS provider invitation delivers the private signer session');
 if(workflow.status!==3){
  await json('/sign/uuid/'+uuid+'/code',{identifyMethod:'email',signMethod:'emailToken'});
  let message;
  for(let i=0;i<15;i++){
   const mailbox=await fetch(mailBase+'/api/v1/messages').then(r=>r.json());
   message=mailbox.messages.find(m=>m.To?.some(t=>t.Address===email));
   if(message)break;
   await new Promise(r=>setTimeout(r,1000));
  }
  assert.ok(message,'Verification email did not reach the isolated mailbox');
  const mail=await fetch(mailBase+'/api/v1/message/'+message.ID).then(r=>r.json());
  await writeFile('.runtime/synthetic-mail.json',JSON.stringify(mail));
  const tokens=[...String(mail.Text).matchAll(/\b[0-9]{6}\b/g)].map(m=>m[0]);
  if(tokens.length!==1) throw new Error('Inspect the protected synthetic mail fixture to identify the code format');
  await json('/sign/uuid/'+uuid,{method:'email',token:tokens[0],identifyValue:email,async:false});
  console.log('PASS anonymous email verification and signing');
 }
 const signed=await client.downloadSigned(expected);assert.notEqual(signed.sha256,sha256);
 await writeFile('.runtime/synthetic-signed.pdf',signed.bytes);
 console.log('PASS signed PDF download and checksum');
 await client.erase(expected,document);
 console.log('PASS provider erasure and repeated erasure');
 await client.erase(expected,document);
 console.log(JSON.stringify({passed:true,sha256:signed.sha256,bytes:signed.bytes.length}));
}catch(error){console.error(JSON.stringify({passed:false,message:error.message,code:error.code,reason:error.reason}));process.exitCode=1;}

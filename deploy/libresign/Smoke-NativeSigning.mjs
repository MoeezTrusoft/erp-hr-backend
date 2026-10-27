import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createLibreSignClient} from './libresignClient.mjs';
// Only a protected disposable restore can invoke this harness.
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.match(config.namespace,/^sign-native-(trusoft|boc|homevision|homenet|joc)$/);
assert.equal(config.base,'http://127.0.0.1:8080');
const base=config.base,mailBase='http://127.0.0.1:8025',api='/ocs/v2.php/apps/libresign/api/v1';
const email='native-probe@example.invalid',tenantId=config.companyId;
const bytes=await readFile(config.pdf),sha256=createHash('sha256').update(bytes).digest('hex');
const client=createLibreSignClient({tenantId,baseUrl:base,username:'erp-recruitment-'+tenantId,appPassword:(await readFile(config.passwordFile,'utf8')).trim(),allowLocalHttp:true,timeoutMs:60000});
const document={offerId:900000002,version:1,sha256};
let expected;
const json=async(path,body)=>{
 const response=await fetch(base+api+path,{method:'POST',headers:{'OCS-APIRequest':'true','Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 const result=await response.json();
 if(!response.ok || result.ocs?.meta?.status!=='ok') throw new Error('Signing operation rejected: '+response.status+' '+JSON.stringify(result.ocs?.data).slice(0,500));
 return result.ocs.data;
};
try{
 for(let i=0;i<30;i++){
  try{if((await fetch(base+'/status.php',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}
  if(i===29)throw new Error('NGINX/FPM did not become ready');
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 for(const path of ['config/config.php','data/.ocdata','lib/base.php'])assert.equal((await fetch(base+'/'+path)).status,404,'Protected application path exposed');
 console.log('PASS NGINX/FPM health and protected paths');
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
  // The verification token remains only in process memory.
  const tokens=[...String(mail.Text).matchAll(/\b[0-9]{6}\b/g)].map(m=>m[0]);
  if(tokens.length!==1) throw new Error('Inspect the protected synthetic mail fixture to identify the code format');
  await json('/sign/uuid/'+uuid,{method:'email',token:tokens[0],identifyValue:email,async:false});
  console.log('PASS anonymous email verification and signing');
 }
 const signed=await client.downloadSigned(expected);assert.notEqual(signed.sha256,sha256);
 await writeFile(config.signedOutput,signed.bytes,{mode:0o600});
 console.log('PASS signed PDF download and checksum');
 await client.erase(expected,document);
 console.log('PASS provider erasure and repeated erasure');
 await client.erase(expected,document);
 console.log(JSON.stringify({passed:true,engine:'PhpNative',sha256:signed.sha256,bytes:signed.bytes.length}));
}catch(error){console.error(JSON.stringify({passed:false,message:error.message,code:error.code,reason:error.reason}));process.exitCode=1;}

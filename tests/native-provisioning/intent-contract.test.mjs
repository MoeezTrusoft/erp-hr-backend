import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import crypto from 'node:crypto';
import {fingerprint} from '../../src/services/intent-contract.mjs';
import {createHrIntentReader} from '../../src/services/hr-intent-reader.mjs';
import {createRbacIntentReceiver} from '../../src/services/rbac-intent-receiver.mjs';
const tenant='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
function fixture(){
 const payload={email:'explicit-system@example.test',hrEmployeeId:123,roles:[{roleId:7}],first_name:'Synthetic'};
 const row={id:'intent',tenantId:tenant,employeeId:123,idempotencyKey:key,payloadFingerprint:fingerprint(payload),payload,actor:{userId:'17',permissions:['STALE']},status:'PROCESSING'};
 const employee={id:123,tenant_id:tenant,employement_status:'Active',separatedAt:null,userId:null,work_email:'directory@example.test'};
 let verified=true,service='rbac',actor=17,granted=true,grantsRead=0,queries=0;
 const verifier=()=>({ok:verified,context:{service,tenantId:tenant,userId:actor}});
 const reader=createHrIntentReader({expectedService:'rbac',verifyServiceRequest:verifier,prisma:{systemAccountProvisioning:{findUnique:async q=>{queries++;assert.equal(q.where.tenantId_idempotencyKey.tenantId,tenant);return row;}}}});
 const receiver=createRbacIntentReceiver({expectedService:'hr',verifyServiceRequest:verifier,
  loadStoredIntent:async(t,i)=>{assert.equal(t,tenant);service='rbac';try{return await reader({body:i});}finally{service='hr';}},
  authorizeCurrentActorTx:async(tx,input)=>{grantsRead++;assert.equal(input.actorUserId,17);assert.equal(input.tenantId,tenant);if(!granted)throw Error('revoked');},readEmployeeTx:async()=>employee});
 return {payload,row,employee,reader,receiver,metadata:{key,fingerprint:row.payloadFingerprint},get queries(){return queries;},get grantsRead(){return grantsRead;},set service(v){service=v;},set actor(v){actor=v;},set granted(v){granted=v;},set verified(v){verified=v;}};
}
test('fingerprint matches captured native worker algorithm, including nested fields',()=>{
 const source=readFileSync(new URL('../../src/jobs/system-account-provisioning.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('const canonicalize ='),source.indexOf('const uuidFromDigest ='));
 const payload={z:[{b:2,a:1}],a:'value'};assert.equal(fingerprint(payload),runInNewContext(block+'digest(payload)',{crypto,payload}));
});
test('reader returns authoritative stored system email and minimal actor identity',async()=>{
 const f=fixture();const proof=await f.reader({body:{employeeId:123,...f.metadata}});
 assert.equal(proof.email,f.payload.email);assert.equal(proof.actorUserId,17);assert.equal(proof.permissions,undefined);assert.equal(proof.payload,undefined);
});
test('invalid service authentication and wrong service cannot read intent',async()=>{
 for(const mode of ['jwt','service']){const f=fixture();if(mode==='jwt')f.verified=false;else f.service='other';await assert.rejects(f.reader({body:{employeeId:123,...f.metadata}}));assert.equal(f.queries,0);}
});
test('reader rejects stale fingerprint, cross-tenant row and changed stored payload',async()=>{
 for(const change of [f=>f.row.payloadFingerprint='0'.repeat(64),f=>f.row.tenantId=key,f=>f.row.payload.email='changed@example.test']){
  const f=fixture();change(f);await assert.rejects(f.reader({body:{employeeId:123,...f.metadata}}));
 }
});
test('receiver accepts stored email override with current grants, without browser session',async()=>{
 const f=fixture();f.service='hr';const prepared=await f.receiver({},f.payload,f.metadata);const result=await prepared.authorizeTx({});
 assert.equal(result.verifiedLoginEmail,f.payload.email);assert.equal(f.grantsRead,1);
});
test('caller payload mutation and signed actor mismatch reject',async()=>{
 const f=fixture();f.service='hr';await assert.rejects(f.receiver({}, {...f.payload,email:'attacker@example.test'},f.metadata));
 f.actor=88;await assert.rejects(f.receiver({},f.payload,f.metadata));
});
test('current actor revocation rejects despite historical permissions',async()=>{
 const f=fixture();f.service='hr';const prepared=await f.receiver({},f.payload,f.metadata);f.granted=false;await assert.rejects(prepared.authorizeTx({}));
});
test('current HR separation and existing account takeover reject',async()=>{
 const f=fixture();f.service='hr';const prepared=await f.receiver({},f.payload,f.metadata);
 f.employee.separatedAt='now';await assert.rejects(prepared.authorizeTx({}));f.employee.separatedAt=null;f.employee.userId=99;
 await assert.rejects(prepared.authorizeTx({}));await assert.rejects(prepared.authorizeTx({},{replayedUserId:100}));
 assert.equal((await prepared.authorizeTx({},{replayedUserId:99})).employee.userId,99);
});
test('prepared authorization uses a snapshot and does not trust returned payload mutations',async()=>{
 const f=fixture();f.service='hr';const prepared=await f.receiver({},f.payload,f.metadata);prepared.payload.email='changed@example.test';f.payload.email='changed-again@example.test';
 assert.equal((await prepared.authorizeTx({})).verifiedLoginEmail,'explicit-system@example.test');
});

test('native fresh bootstrap passwords preserve stored business proof and current authorization',async()=>{
 const f=fixture();f.service='hr';
 for(const password of ['synthetic-first-bootstrap','synthetic-replay-bootstrap']){
  const submitted={...f.payload,password};const prepared=await f.receiver({},submitted,f.metadata);
  assert.equal(Object.hasOwn(prepared.payload,'password'),false);assert.equal(submitted.password,password);assert.equal((await prepared.authorizeTx({})).verifiedLoginEmail,f.payload.email);
 }
 assert.equal(f.grantsRead,2);
});
test('password exclusion does not exclude any submitted business field',async()=>{
 for(const changed of [{email:'changed@example.test'},{roles:[{roleId:99}]},{hrEmployeeId:124},{first_name:'Changed'},{unexpected:'field'}]){
  const f=fixture();f.service='hr';await assert.rejects(f.receiver({},{...f.payload,password:'synthetic-bootstrap',...changed},f.metadata));assert.equal(f.grantsRead,0);
 }
});
test('fresh bootstrap password cannot bypass revoked current grants',async()=>{
 const f=fixture();f.service='hr';const prepared=await f.receiver({},{...f.payload,password:'synthetic-bootstrap'},f.metadata);f.granted=false;await assert.rejects(prepared.authorizeTx({}));assert.equal(f.grantsRead,1);
});
test('fresh bootstrap password cannot bypass signed actor binding',async()=>{
 const f=fixture();f.service='hr';f.actor=88;await assert.rejects(f.receiver({},{...f.payload,password:'synthetic-bootstrap'},f.metadata));
});
test('fresh password replay still requires exact existing employee link',async()=>{
 const f=fixture();f.service='hr';f.employee.userId=99;const prepared=await f.receiver({},{...f.payload,password:'synthetic-replay'},f.metadata);
 await assert.rejects(prepared.authorizeTx({},{replayedUserId:100}));assert.equal((await prepared.authorizeTx({},{replayedUserId:99})).employee.userId,99);
});

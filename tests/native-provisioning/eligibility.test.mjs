import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHrEligibilityReader} from '../../src/services/hr-eligibility-reader.mjs';
const tenant='11111111-1111-4111-8111-111111111111';
function fixture(){
 const f={calls:[],context:{service:'erp-rbac',tenantId:tenant},ok:true,row:{id:123,tenant_id:tenant,employement_status:'Active',separatedAt:null,userId:null,email:'synthetic@example.invalid',work_email:null}};
 f.read=createHrEligibilityReader({expectedService:'erp-rbac',verifyServiceRequest:async()=>({ok:f.ok,context:f.context}),prisma:{employee:{findFirst:async query=>{f.calls.push(query);return f.row;}}}});return f;
}
test('eligibility uses verified service tenant and selects only account-security fields',async()=>{
 const f=fixture();assert.deepEqual(await f.read({body:{employeeId:123}}),f.row);
 assert.deepEqual(f.calls,[{where:{id:123,tenant_id:tenant},select:{id:true,tenant_id:true,employement_status:true,separatedAt:true,userId:true,email:true,work_email:true}}]);
});
test('eligibility rejects unauthenticated, wrong peer and invalid tenant before database access',async()=>{
 for(const mutate of [f=>f.ok=false,f=>f.context.service='erp-gateway',f=>f.context.tenantId='invalid']){
  const f=fixture();mutate(f);await assert.rejects(f.read({body:{employeeId:123}}),{status:403});assert.equal(f.calls.length,0);
 }
});
test('eligibility strictly rejects noninteger selectors and caller-supplied authority',async()=>{
 for(const body of [null,{},[],{employeeId:'123'},{employeeId:0},{employeeId:-1},{employeeId:1.1},{employeeId:2147483648},{employeeId:123,tenantId:tenant},{employeeId:123,isAdmin:true}]){
  const f=fixture();await assert.rejects(f.read({body}),{status:403});assert.equal(f.calls.length,0);
 }
});
test('eligibility denies inconsistent subject or tenant returned by storage',async()=>{
 for(const patch of [{id:124},{tenant_id:'22222222-2222-4222-8222-222222222222'}]){const f=fixture();Object.assign(f.row,patch);await assert.rejects(f.read({body:{employeeId:123}}),{status:403});}
});
test('eligibility returns absence and preserves separation facts without manufacturing eligibility',async()=>{
 const f=fixture();f.row=null;assert.equal(await f.read({body:{employeeId:123}}),null);
 f.row={id:123,tenant_id:tenant,employement_status:'Separated',separatedAt:'2026-01-01',userId:99};assert.deepEqual(await f.read({body:{employeeId:123}}),f.row);
});
test('HR reader routes follow native service and tenant guards',()=>{const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');const app=read('../../src/app.js');for(const endpoint of ['resolve','contact','eligibility']){const route=app.indexOf('app.post("/api/internal/system-account-provisioning/'+endpoint+'"');assert.ok(route>app.indexOf('app.use("/api", establishTenantContext)'));assert.ok(route>app.indexOf('internalServiceGuard'));}assert.ok(read('../../src/services/provisioning-reader-native.mjs').includes("expectedService:'erp-rbac'"));});

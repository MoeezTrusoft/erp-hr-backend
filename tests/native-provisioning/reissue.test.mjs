import test from "node:test";
import assert from "node:assert/strict";
import { recoveryPrincipal, reissueForEmployee } from "../../src/services/employee-provisioning-reissue.mjs";
import { fingerprint } from "../../src/services/intent-contract.mjs";

const tenantId = "066dd015-2820-47b5-b2fc-1e9704f0f420";
const context = {source:"service-jwt", alg:"EdDSA", tenantId, claims: {
  uid:8, iss:"erp-gateway", svc:"hr", actor:{type:"user",id:8}, act:{sub:"8",sid:"s",tid:tenantId},
  scope:"hr.employee.update rbac.employee.create",
}};
const request = {roleId:232, employeeCode:"EMP-0005", email:"owner@example.test"};
function fixture() {
  const payload = {email:request.email, hrEmployeeId:649, roles:[{roleId:230}]};
  let row = {id:"intent",tenantId,employeeId:649,status:"TERMINAL_FAILED",lastHttpStatus:403,
    lastError:"Insufficient permissions: rbac:employee:CREATE",payload,payloadFingerprint:fingerprint(payload)};
  let updates=0;
  const tx={log:{create:async()=>({})},employee:{findFirst:async ({where})=>where.tenant_id===tenantId && where.id===649 &&
    where.employee_code===request.employeeCode ? {work_email:request.email,employement_status:"Active"}:null},
    systemAccountProvisioning:{findUnique:async()=>row,updateMany:async({data})=>{
      updates++;row={...row,...data};return {count:1};
    }}};
  return {tx, calls:()=>updates};
}
test("require signed human tenant and both delegated permissions",()=>{
  for(const diff of [{scope:"hr.employee.update"},{scope:"rbac.employee.create"},{actor:{type:"automation",id:8}},
    {act:{sub:"8",tid:"another",sid:"s"}},{iss:"other"}]){
    assert.throws(()=>recoveryPrincipal({...context,claims:{...context.claims,...diff}}),{status:403});
  }
});
test("explicit recipient role is independent of operator and repeat submits converge",async()=>{
  const {tx,calls}=fixture();const actor=recoveryPrincipal(context);
  const first=await reissueForEmployee(tx,actor,649,request);
  const second=await reissueForEmployee(tx,actor,649,request);
  assert.equal(second.correlationId,first.correlationId); assert.equal(calls(),1);
  assert.deepEqual(first.payload.roles,[{roleId:232}]);assert.equal(first.actor.userId,"8");
  assert.deepEqual(first.actor.roles,[]);assert.equal(first.payloadFingerprint,fingerprint(first.payload));
});
test("mismatched employee code, company, or email cannot change the failed request",async()=>{
  const {tx,calls}=fixture();const actor=recoveryPrincipal(context);
  for(const [a,id,body] of [[actor,648,request],[actor,649,{...request,email:"other@example.test"}],
    [actor,649,{...request,employeeCode:"EMP-0007"}],[{...actor,tenantId:"other"},649,request]]){
    await assert.rejects(reissueForEmployee(tx,a,id,body),{status:404});
  }
  assert.equal(calls(),0);
});

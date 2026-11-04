import {reject,selector,sameDigest,fingerprint,verifiedService} from './intent-contract.mjs';
// Wire into HR after its native service-JWT and tenant-context middleware.
// The verifier is invoked again; request headers/body cannot supply claims.
export function createHrIntentReader({prisma,verifyServiceRequest,expectedService}){
 return async function read(request){
  const service=await verifiedService(request,verifyServiceRequest,expectedService);
  const input=selector(request.body);
  const row=await prisma.systemAccountProvisioning.findUnique({
   where:{tenantId_idempotencyKey:{tenantId:service.tenantId,idempotencyKey:input.key}},
   select:{id:true,tenantId:true,employeeId:true,idempotencyKey:true,payloadFingerprint:true,payload:true,actor:true,status:true},
  });
  if(!row||row.tenantId!==service.tenantId||row.employeeId!==input.employeeId||row.idempotencyKey!==input.key||
   !sameDigest(row.payloadFingerprint,input.fingerprint)||!sameDigest(fingerprint(row.payload),row.payloadFingerprint)||
   Number(row.payload?.hrEmployeeId)!==row.employeeId||!['PENDING','PROCESSING','RETRY_WAIT','SUCCEEDED'].includes(row.status))reject();
  const actorUserId=Number(row.actor?.userId),email=row.payload?.email;
  if(!Number.isSafeInteger(actorUserId)||actorUserId<=0||actorUserId>2147483647||typeof email!=='string'||!email.trim())reject();
  // Email is the persisted HR-selected contact (including systemEmail).
  // Never export the actor's historical permissions, roles or session.
  return {id:row.id,tenantId:row.tenantId,employeeId:row.employeeId,key:row.idempotencyKey,
   fingerprint:row.payloadFingerprint,actorUserId,email,status:row.status};
 };
}

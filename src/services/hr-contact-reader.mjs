import {reject,isUuid,verifiedService,fingerprint,sameDigest} from './intent-contract.mjs';
export function createHrContactReader({prisma,verifyServiceRequest,expectedService}){
 return async request=>{
  const principal=await verifiedService(request,verifyServiceRequest,expectedService);
  const {employeeId,userId}=request.body??{};
  if(Object.keys(request.body??{}).some(k=>!['employeeId','userId'].includes(k))||![employeeId,userId].every(x=>Number.isSafeInteger(x)&&x>0&&x<=2147483647))reject();
  const row=await prisma.systemAccountProvisioning.findUnique({where:{tenantId_employeeId:{tenantId:principal.tenantId,employeeId}},
   select:{tenantId:true,employeeId:true,payload:true,payloadFingerprint:true,rbacUserId:true,status:true}});
  if(!row)return null;
  if(!isUuid(row.tenantId)||row.tenantId!==principal.tenantId||row.employeeId!==employeeId||row.status!=='SUCCEEDED'||
   String(row.rbacUserId)!==String(userId)||!sameDigest(fingerprint(row.payload),row.payloadFingerprint)||
   Number(row.payload.hrEmployeeId)!==employeeId||typeof row.payload.email!=='string'||!row.payload.email.trim())reject();
  return {tenantId:row.tenantId,employeeId,userId,email:row.payload.email};
 };
}

import {reject,verifiedService} from './intent-contract.mjs';
// Account-security contract for the authenticated RBAC service. No human role,
// scope or session is fabricated to call a human HR management route.
export function createHrEligibilityReader({prisma,verifyServiceRequest,expectedService}){
 return async request=>{
  const principal=await verifiedService(request,verifyServiceRequest,expectedService);
  const body=request.body??{},id=body.employeeId;
  if(Object.keys(body).length!==1||!Number.isSafeInteger(id)||id<=0||id>2147483647)reject();
  const employee=await prisma.employee.findFirst({where:{id,tenant_id:principal.tenantId},
   select:{id:true,tenant_id:true,employement_status:true,separatedAt:true,userId:true,email:true,work_email:true}});
  if(employee&&(employee.id!==id||employee.tenant_id!==principal.tenantId))reject();
  return employee;
 };
}

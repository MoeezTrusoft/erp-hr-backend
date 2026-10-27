// Numeric actor references are RBAC user IDs, never assumed Employee IDs.
export async function attendanceActorCodes(db, tenantId, values) {
  const refs=[...new Set(values.filter(v=>v!=null).map(String))];
  if(!refs.length)return new Map();
  const userIds=refs.filter(v=>/^\d+$/.test(v)).map(Number).filter(Number.isSafeInteger);
  const employees=await db.employee.findMany({where:{tenant_id:tenantId,OR:[{userId:{in:userIds}},{employee_code:{in:refs}}]},select:{userId:true,employee_code:true}});
  const result=new Map();
  for(const ref of refs){const matches=employees.filter(e=>e.employee_code===ref||(e.userId!=null&&String(e.userId)===ref));result.set(ref,matches.length===1?matches[0].employee_code:null);}
  return result;
}

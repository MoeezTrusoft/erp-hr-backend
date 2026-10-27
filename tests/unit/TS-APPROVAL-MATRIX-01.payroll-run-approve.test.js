// Legacy matrices cannot authorize terminal decisions. PostgreSQL tests cover the staged process.
import {describe,it,expect,jest} from '@jest/globals';
const run={id:42,processedBy:900,status:'COMPLETED'}, update=jest.fn(), matrix=jest.fn();
jest.unstable_mockModule('../../src/lib/prisma.js',()=>({default:{employee:{findMany:async()=>[{id:558,userId:558,employee_code:'EMP-558',status:'Active'}],findFirst:async()=>({id:900,employee_code:'EMP-900',managerId:558})},payrollRun:{findFirst:async()=>run,update,updateMany:update},payrollPayslip:{findMany:async()=>[]},payrollApprovalMatrix:{findMany:matrix}}}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js',()=>({tenantTransaction:async(db,fn)=>fn(db)}));
const {mcpCtx}=await import('../../src/mcp/context.js');
const {approvePayrollRun}=await import('../../src/services/payrollService.js');
describe('Legacy payroll matrix cannot bypass staged review',()=>{
 for(const rows of [[{level:1,approverId:558,role:'HR'}],[{level:1,approverId:777,role:'MANAGEMENT'}],[],[{level:1,approverId:null}]])it('requires the staged workflow with matrix '+JSON.stringify(rows),async()=>{matrix.mockResolvedValue(rows);await expect(mcpCtx.run({actorVerified:true,user:{tenantId:'40314ef4-0a81-4390-b631-b3ad3f21f523',userId:558},permissions:['hr.approvals.manager']},()=>approvePayrollRun(42,558,'40314ef4-0a81-4390-b631-b3ad3f21f523'))).rejects.toMatchObject({status:409,code:'HR-4201'});expect(update).not.toHaveBeenCalled();expect(run.status).toBe('COMPLETED');});
});

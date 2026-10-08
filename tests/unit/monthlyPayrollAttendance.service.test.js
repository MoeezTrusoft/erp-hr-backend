import {jest,describe,it,expect,beforeEach} from '@jest/globals';
const db={employee:{findFirst:jest.fn(),updateMany:jest.fn()},monthlyPayrollAttendance:{findFirst:jest.fn(),create:jest.fn(),updateMany:jest.fn()},payrollRun:{findMany:jest.fn(),findFirst:jest.fn()},payrollAuditLog:{count:jest.fn(),create:jest.fn()}};
jest.unstable_mockModule('../../src/lib/prisma.js',()=>({default:db}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js',()=>({tenantTransaction:async(_,fn)=>fn(db)}));
const {saveMonthlyAttendance,assignPayrollOffice}=await import('../../src/services/monthlyPayrollAttendance.service.js');
const args={tenantId:'tenant-a',employeeId:7,month:'2026-09',payableDays:30,reason:'Signed register',version:0,actorId:11};
beforeEach(()=>{jest.resetAllMocks();db.employee.findFirst.mockResolvedValue({id:7,attendanceInputMode:'MANUAL_MONTHLY',version:2});db.payrollRun.findMany.mockResolvedValue([]);db.payrollRun.findFirst.mockResolvedValue(null);db.payrollAuditLog.count.mockResolvedValue(0);db.monthlyPayrollAttendance.findFirst.mockResolvedValue(null);db.monthlyPayrollAttendance.create.mockResolvedValue({id:9,version:1});db.employee.updateMany.mockResolvedValue({count:1});});
describe('monthly attendance writes',()=>{
 it('saves zero days with tenant and actor audit',async()=>{await saveMonthlyAttendance({...args,payableDays:0});expect(db.monthlyPayrollAttendance.create).toHaveBeenCalledWith({data:expect.objectContaining({tenantId:'tenant-a',employeeId:7,payableDays:0,updatedById:11})});expect(db.payrollAuditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({tenantId:'tenant-a',action:'MONTHLY_ATTENDANCE_SAVED'})});});
 it('rejects an employee outside the tenant',async()=>{db.employee.findFirst.mockResolvedValue(null);await expect(saveMonthlyAttendance(args)).rejects.toMatchObject({status:404});expect(db.employee.findFirst.mock.calls[0][0].where.tenant_id).toBe('tenant-a');expect(db.monthlyPayrollAttendance.create).not.toHaveBeenCalled();});
 it('rejects stale input',async()=>{db.monthlyPayrollAttendance.findFirst.mockResolvedValue({version:2});await expect(saveMonthlyAttendance(args)).rejects.toMatchObject({status:409});});
 it('locks processed payroll',async()=>{db.payrollRun.findMany.mockResolvedValue([{id:1,status:'FINALIZED'}]);await expect(saveMonthlyAttendance(args)).rejects.toMatchObject({status:409});});
 it('locks submitted pending payroll',async()=>{db.payrollRun.findMany.mockResolvedValue([{id:1,status:'PENDING'}]);db.payrollAuditLog.count.mockResolvedValue(1);await expect(saveMonthlyAttendance(args)).rejects.toMatchObject({status:409});});
 it('does not write monthly input for a device employee',async()=>{db.employee.findFirst.mockResolvedValue({id:7,attendanceInputMode:'DEVICE'});await expect(saveMonthlyAttendance(args)).rejects.toMatchObject({status:400});});
 it('audits office changes and increments employee version',async()=>{const r=await assignPayrollOffice({...args,version:2,office:'HVC-Headend-Staff',mode:'MANUAL_MONTHLY'});expect(r.version).toBe(3);expect(db.employee.updateMany.mock.calls[0][0].where).toEqual({id:7,tenant_id:'tenant-a',version:2});});
});

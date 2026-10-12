// Per-shift time validation and immutability are covered by attendanceRules.workflow.test.js.
import {it,expect} from '@jest/globals';
import {correctAttendanceDay} from '../../src/services/attendanceCorrection.service.js';
it('retires the old day-level correction route without accepting an administrator bypass',async()=>{
 await expect(correctAttendanceDay({tenantId:'tenant-a',employeeId:1,date:'2026-10-01',checkIn:'09:00',isAdmin:true})).rejects.toMatchObject({status:410});
});

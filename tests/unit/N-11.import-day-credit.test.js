import { describe, it, expect } from '@jest/globals';
import { runAttendanceImport, commitAttendanceImport } from '../../src/services/attendanceImport.service.js';
import { captureDb, TENANT } from '../helpers/captureDb.js';
describe('reviewed historical import credit', () => {
  it.each([
    ['WORKING', 'PRESENT', '09:00', '17:00', 1],
    ['WORKING', 'HALF_DAY', '09:00', '12:00', 0.5],
    ['WORKING', 'ABSENT', '', '', 0],
    ['WEEKLY_OFF', '', '', '', 0],
    ['HOLIDAY', 'PRESENT', '09:00', '15:00', 1],
  ])('commits %s / %s credit only after the authorized preview', async (dayType, status, start, end, credit) => {
    const db = captureDb();
    const csv = `employee_code,date,day_type,status,check_in,check_out
EMP1,2026-08-03,${dayType},${status},${start},${end}`;
    const preview = await runAttendanceImport({ tenantId: TENANT, actorId: 'hr-1',
      fileBase64: Buffer.from(csv).toString('base64'), format: 'csv',
      approvalReference: 'Verified historical register' }, db);
    expect(preview.summary.errors).toBe(0);
    expect(db.snapshot().attendance).toHaveLength(0);
    await commitAttendanceImport({ tenantId: TENANT, actorId: 'hr-1', batchId: preview.batchId,
      previewToken: preview.previewToken, reason: 'Approved historical migration' }, db);
    expect(db.snapshot().attendance[0]).toMatchObject({ day_credit: credit, status: status || dayType });
  });
});

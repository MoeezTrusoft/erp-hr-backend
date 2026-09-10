// N-11 — the attendance importer must write day_credit.
//
// The upsert stores status but never day_credit, so every imported row lands
// with NULL credit — "held" in payroll terms — and the N-01 bridge prices
// nothing for imported months (wrong by omission, forever). The credit
// mapping is the same one the correction path uses (creditFor): PRESENT/LATE
// → 1, HALF_DAY → 0.5, ABSENT → 0. Rest-day statuses (WEEKLY_OFF/HOLIDAY/
// ON_LEAVE, post-N-12) keep 0 — the payroll bridge skips them by status.
import { jest } from '@jest/globals';

const upsertMock = jest.fn(async () => ({}));
const prismaMock = {
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    attendance: { upsert: upsertMock },
    leave: { findFirst: jest.fn(async () => null), update: jest.fn(), create: jest.fn(async () => ({})) },
    attendanceAnomaly: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    employee: { findMany: jest.fn(async () => [{ id: 11, employee_code: 'EMP-1' }]) },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));

const { runAttendanceImport } = await import('../../src/services/attendanceImport.service.js');

const csv = (rows) =>
    'employee_code,date,day_type,status,check_in,check_out,work_mode,leave_type,anomaly_type,anomaly_resolution,remarks\n' +
    rows.join('\n');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('N-11 importer writes day_credit', () => {
    beforeEach(() => jest.clearAllMocks());

    it('upserts credit 1 / 0.5 / 0 by status, on create AND update', async () => {
        const file = csv([
            'EMP-1,2026-08-03,WORKING,PRESENT,09:00,18:00,,,,',
            'EMP-1,2026-08-04,WORKING,HALF_DAY,09:00,12:00,,,,',
            'EMP-1,2026-08-05,WORKING,ABSENT,,,,,,',
        ]);
        const out = await runAttendanceImport({ tenantId: 't-uuid', fileBase64: b64(file), format: 'csv', dryRun: false });

        expect(out.summary.errors).toBe(0);
        expect(upsertMock).toHaveBeenCalledTimes(3);
        const credits = upsertMock.mock.calls.map(([a]) => [a.create.day_credit, a.update.day_credit]);
        expect(credits).toEqual([[1, 1], [0.5, 0.5], [0, 0]]);
    });

    it('rest-day statuses carry credit 0 (the bridge skips them by status)', async () => {
        const file = csv(['EMP-1,2026-08-02,WEEKLY_OFF,,,,,,,']);
        await runAttendanceImport({ tenantId: 't-uuid', fileBase64: b64(file), format: 'csv', dryRun: false });
        const arg = upsertMock.mock.calls[0][0];
        expect(arg.create.status).toBe('WEEKLY_OFF');
        expect(arg.create.day_credit).toBe(0);
    });

    it('an explicit status on a rest-day row keeps its own credit', async () => {
        // HR sends day_type=HOLIDAY but status=PRESENT (worked the holiday):
        // the punches are real, the credit is 1.
        const file = csv(['EMP-1,2026-08-14,HOLIDAY,PRESENT,09:00,15:00,,,,']);
        await runAttendanceImport({ tenantId: 't-uuid', fileBase64: b64(file), format: 'csv', dryRun: false });
        const arg = upsertMock.mock.calls[0][0];
        expect(arg.create.status).toBe('PRESENT');
        expect(arg.create.day_credit).toBe(1);
    });
});

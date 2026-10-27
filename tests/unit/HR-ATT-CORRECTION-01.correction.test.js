// HR-ATT-CORRECTION-01 — HR/admin manual attendance correction.
//
// The device cannot be the only authority: it was out of service on some days,
// people press the wrong key, and HR holds a reconciled record the machine never
// saw. August produced 527 employee-days needing human review.
//
// The property that matters most is that a correction SURVIVES the next device
// sync. If the roll-up overwrites it, HR fixes a day, the next push undoes it,
// and nobody notices until payroll is wrong.
//
// HR-ATT-CORRECTION-POLICY-01 (operator items 7+8, 2026-09-15) narrows the
// surface:
//   #7 — a manual correction may ONLY fix a MISSING_CHECKIN / MISSING_CHECKOUT
//        day. Device-scored days are out of scope (anomaly/leave workflow).
//   #8 — a day with NO device row is a manual ENTRY: WFH (Remote/Hybrid) only,
//        landing PENDING management approval (requires_regularization stays
//        true, day_credit stays null until approved).
// Status is always DERIVED from the supplied times, never asserted by the
// caller — a correction supplies the missing punch, it does not re-grade.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';
const EMP = 100;
const HR_ACTOR = 900;

let attendanceRows;
let logs;
let employeeWorkMode;
let employeeTenant;

const prismaMock = {
    employee: {
        findMany: jest.fn(async () => [{id:1,employee_code:"EMP-001"}]), findUnique: jest.fn(async () => ({ id: EMP, tenant_id: employeeTenant, work_mode: employeeWorkMode })) },
    attendance: {
        findFirst: jest.fn(async ({ where }) =>
            attendanceRows.find((r) => r.employeeId === where.employeeId
                && (!where.date?.getTime || r.date.getTime() === where.date.getTime())) ?? null),
        findMany: jest.fn(async () => attendanceRows.filter((r) => r.manually_corrected)),
        create: jest.fn(async ({ data }) => { const r = { id: attendanceRows.length + 1, ...data }; attendanceRows.push(r); return r; }),
        update: jest.fn(async ({ where, data }) => {
            const r = attendanceRows.find((x) => x.id === where.id);
            Object.assign(r, data);
            return r;
        }),
    },
    log: { create: jest.fn(async ({ data }) => { logs.push(data); return { id: logs.length, ...data }; }) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
    tenantTransaction: jest.fn(async (_c, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../src/services/attendanceCorrection.service.js');

const base = { tenantId: TENANT, employeeId: EMP, actorEmployeeId: HR_ACTOR, reason: 'machine was down' };

beforeEach(() => {
    jest.clearAllMocks();
    attendanceRows = [];
    logs = [];
    employeeWorkMode = 'Remote'; // WFH by default: manual entries are the allowed path
    employeeTenant = TENANT;
});





describe('HR-ATT-CORRECTION-01 audit listing', () => {
    it('returns only corrected days', async () => {
        attendanceRows.push(
            { id: 1, employeeId: EMP, date: new Date('2026-08-01'), manually_corrected: true },
            { id: 2, employeeId: EMP, date: new Date('2026-08-02'), manually_corrected: false },
        );

        const rows = await svc.listCorrections({ tenantId: TENANT });

        expect(rows.map((r) => r.id)).toEqual([1]);
    });
});

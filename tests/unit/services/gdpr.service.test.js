// HR-SEC-02 — GDPR "right to be forgotten" completeness + tenant isolation.
//
// Finding (audit-reports/12-comprehensive-gap-register.md, A-HR rows):
//   * HOLE 2 — eraseEmployeeData (gdpr.service.js:31-62) leaves bank accounts,
//     salary (employment terms), payslips, leave, attendance, and performance
//     reviews INTACT, so report-10's HR-SEC-02 "met" is false: PII survives.
//   * HOLE 1 (service half) — export/erase take a raw employee id with NO tenant
//     scope, so a tenant-B caller can export/erase a tenant-A employee.
//
// These specs mock the shared Prisma singleton and assert:
//   (red, pre-fix) a cross-tenant export/erase ACTS on another tenant's row, and
//   the erase does NOT touch bank/salary/payslip/leave/attendance/review.
//   (green, post-fix) cross-tenant is fail-closed (throws 404; no writes) and a
//   same-tenant erase removes every listed PII category.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mk = () => ({
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
});

const models = [
    'employee', 'emergencyContacts', 'employeeMedia', 'employeeLifecycleEvent',
    'employeeSkill', 'developmentPlan', 'reimbursementClaim', 'leave', 'attendance',
    'payrollPayslip', 'employmentTerms', 'payrollAssignment', 'bankDetail',
    'performanceReview', 'reviewFeedback', 'goal', 'certification', 'log',
    'payrollAuditLog',
];

const prismaMock = {};
for (const m of models) prismaMock[m] = mk();
// $transaction(cb) runs the callback with the same mock acting as `tx`.
prismaMock.$transaction = jest.fn(async (cb) => cb(prismaMock));

jest.unstable_mockModule('../../../src/config/prisma.js', () => ({ default: prismaMock }));

const gdpr = await import('../../../src/services/gdpr.service.js');

const TENANT_A = '14c350e8-d0bc-4ee9-90c7-dea2b7a7a007';
const TENANT_B = 'b71f3d2a-9c44-4e6f-8a10-1f2e3d4c5b6a';
const EMP_ID = 42;

beforeEach(() => {
    for (const m of models) {
        for (const fn of Object.values(prismaMock[m])) fn.mockReset?.();
        prismaMock[m].findMany.mockResolvedValue([]);
        prismaMock[m].update.mockResolvedValue({});
        prismaMock[m].updateMany.mockResolvedValue({ count: 0 });
        prismaMock[m].deleteMany.mockResolvedValue({ count: 0 });
    }
    prismaMock.$transaction.mockReset();
    prismaMock.$transaction.mockImplementation(async (cb) => cb(prismaMock));
});

describe('HR-SEC-02 — cross-tenant isolation (HOLE 1, service half)', () => {
    it('export of a tenant-A employee by a tenant-B caller is fail-closed (404, no data)', async () => {
        // employee resolves to NULL when scoped to tenant B (belongs to A)
        prismaMock.employee.findFirst.mockResolvedValue(null);
        prismaMock.employee.findUnique.mockResolvedValue({ id: EMP_ID, first_name: 'Ada' });

        await expect(gdpr.exportEmployeeData(EMP_ID, TENANT_B)).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it('erase of a tenant-A employee by a tenant-B caller does NOT delete/anonymize anything', async () => {
        prismaMock.employee.findFirst.mockResolvedValue(null);

        await expect(gdpr.eraseEmployeeData(EMP_ID, TENANT_B)).rejects.toMatchObject({
            statusCode: 404,
        });
        expect(prismaMock.employee.update).not.toHaveBeenCalled();
        expect(prismaMock.bankDetail.deleteMany).not.toHaveBeenCalled();
    });
});

describe('HR-SEC-02 — erasure now removes the related PII (HOLE 2)', () => {
    beforeEach(() => {
        prismaMock.employee.findFirst.mockResolvedValue({ id: EMP_ID, tenant_id: TENANT_A });
    });

    it('deletes bank accounts, salary (employment terms), payslips, assignments, leave, attendance', async () => {
        await gdpr.eraseEmployeeData(EMP_ID, TENANT_A);

        expect(prismaMock.bankDetail.deleteMany).toHaveBeenCalled();
        expect(prismaMock.employmentTerms.deleteMany).toHaveBeenCalled();
        expect(prismaMock.payrollPayslip.deleteMany).toHaveBeenCalled();
        expect(prismaMock.payrollAssignment.deleteMany).toHaveBeenCalled();
        expect(prismaMock.leave.deleteMany).toHaveBeenCalled();
        expect(prismaMock.attendance.deleteMany).toHaveBeenCalled();
    });

    it('removes performance-review PII (review + feedback)', async () => {
        await gdpr.eraseEmployeeData(EMP_ID, TENANT_A);

        // reviews received are anonymized/removed and their feedback PII cleared
        const reviewTouched =
            prismaMock.performanceReview.deleteMany.mock.calls.length > 0 ||
            prismaMock.performanceReview.updateMany.mock.calls.length > 0;
        const feedbackTouched =
            prismaMock.reviewFeedback.deleteMany.mock.calls.length > 0 ||
            prismaMock.reviewFeedback.updateMany.mock.calls.length > 0;
        expect(reviewTouched).toBe(true);
        expect(feedbackTouched).toBe(true);
    });

    it('still anonymizes the employee root record (no-over-erase regression)', async () => {
        await gdpr.eraseEmployeeData(EMP_ID, TENANT_A);
        expect(prismaMock.employee.update).toHaveBeenCalledTimes(1);
        const arg = prismaMock.employee.update.mock.calls[0][0];
        expect(arg.data.first_name).toBeNull();
        expect(arg.data.email).toBeNull();
    });

    it('runs the whole erase inside a single transaction', async () => {
        await gdpr.eraseEmployeeData(EMP_ID, TENANT_A);
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });
});

describe('HR-SEC-02 — same-tenant export still works (no over-deny)', () => {
    it('returns the export bundle for an in-tenant employee', async () => {
        prismaMock.employee.findFirst.mockResolvedValue({ id: EMP_ID, tenant_id: TENANT_A, first_name: 'Ada' });

        const out = await gdpr.exportEmployeeData(EMP_ID, TENANT_A);
        expect(out.employee).toMatchObject({ id: EMP_ID });
        expect(out).toHaveProperty('exportedAt');
    });
});

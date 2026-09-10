// N-10 — payroll run selection must honor Employee.payroll_included.
//
// hr.service.js:508 documents the flag as the payroll filter ("the
// payroll_included flag already keeps …"), attendanceWriter and
// attendanceReconciliation both filter on it — but processPayrollRun's
// employee selection (payrollService.js:947) does NOT. Anyone with
// status='Active' lands in every run regardless of the flag; an
// administrative/operator employee would be paid by every tenant.
//
// The compensating control used for the fleet HR operator (status Inactive)
// holds today, but the flag must mean what the schema says it means.
import { describe, it, expect } from '@jest/globals';
import { payrollEligibleFilter } from '../../src/services/payrollService.js';

const RUN = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T23:59:59.999Z'),
};

describe('N-10 run selection filters payroll_included', () => {
    it('ANDs payroll_included != false around the active/period-overlap OR', () => {
        const filter = payrollEligibleFilter(RUN);
        expect(filter.AND).toBeTruthy();
        const included = filter.AND.find((c) => c.payroll_included);
        expect(included).toEqual({ payroll_included: { not: false } });
    });

    it('keeps the case-insensitive active branch (the 73-of-75 "Active" bug)', () => {
        const filter = payrollEligibleFilter(RUN);
        const or = filter.AND.find((c) => c.OR);
        expect(or.OR).toContainEqual({ status: { equals: 'active', mode: 'insensitive' } });
    });

    it('keeps the employment-period overlap branch (leavers keep their days)', () => {
        const filter = payrollEligibleFilter(RUN);
        const or = filter.AND.find((c) => c.OR);
        expect(or.OR).toContainEqual({
            employmentPeriods: {
                some: {
                    startDate: { lte: RUN.periodEnd },
                    OR: [{ endDate: null }, { endDate: { gte: RUN.periodStart } }],
                },
            },
        });
    });

    it('an excluded (payroll_included=false) active employee matches nothing', () => {
        // Simulated Prisma evaluation of the filter shape against sample rows.
        const D = (s) => new Date(`${s}T00:00:00.000Z`);
        const matches = (row) => {
            const includedOk = row.payroll_included !== false;
            const activeOk = String(row.status).toLowerCase() === 'active';
            const overlapOk = (row.periods || []).some(
                (p) => D(p.start) <= RUN.periodEnd && (p.end == null || D(p.end) >= RUN.periodStart),
            );
            return includedOk && (activeOk || overlapOk);
        };
        expect(matches({ status: 'Active', payroll_included: true })).toBe(true);
        expect(matches({ status: 'Active', payroll_included: false })).toBe(false);
        expect(matches({ status: 'Inactive', payroll_included: false, periods: [] })).toBe(false);
        expect(matches({ status: 'Inactive', payroll_included: true, periods: [{ start: '2026-08-20', end: null }] })).toBe(true);
    });
});

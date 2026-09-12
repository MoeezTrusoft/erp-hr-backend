// N-21 — TAX-BASE UPLIFT: Section 149 withholds on the CONTRACTED monthly
// package; absence days leave net pay through the deduction lines, not the tax
// base. HR's August 2026 register pins the convention:
//   Abdullah — gross prorated to 84,194 (2 days off) yet tax 400 = 1% of
//              (90,000 − 50,000): the FULL package crosses the slab.
//   Meesam   — earned 36,774 (19/31) yet tax 100 = 1% of (60,000 − 50,000):
//              the prorated base alone sat under the 50K exempt floor, so the
//              pre-N-21 engine charged 0 and diverged from HR by exactly 100.
// For a full-month employee proration is 1.0 → uplift 0 → base unchanged
// (byte-stable with N-13 behaviour).
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

// 1% of the monthly slice exceeding 50,000 — the operative FBR band here.
const RATES = [{ countryCode: 'PK', bracketMin: 50000, bracketMax: null, rate: 0.01, effectiveFrom: '2026-01-01' }];

const mkRun = () => ({
    periodStart: new Date('2026-08-01T00:00:00Z'),
    periodEnd: new Date('2026-08-31T00:00:00Z'),
    currencyCode: 'PKR',
    countryCode: 'PK',
});

const mkEmp = (periods) => ({ employmentPeriods: periods });

// 19/31 employment (Meesam): Aug 1–19.
const PART_MONTH = [{ startDate: new Date('2026-08-01T00:00:00Z'), endDate: new Date('2026-08-19T00:00:00Z') }];
// Full month.
const FULL_MONTH = [{ startDate: new Date('2026-01-01T00:00:00Z'), endDate: null }];

const term = (pkg) => ({ baseSalary: pkg, currency: 'PKR', baseSalaryEarningTypeId: null });

const taxLine = (slip) => slip.deductions.find((d) => d.code === 'INCOME_TAX');

describe('N-21 — tax base uses the contracted package for prorated employees', () => {
    it('charges 100 on a 60,000 package earned 19/31 (HR Meesam case)', () => {
        const slip = buildPayslipFromInputs({
            employee: mkEmp(PART_MONTH),
            employmentTerm: term('60000'),
            assignments: [],
            payrollRun: mkRun(),
            taxRateRows: RATES,
        });
        // Base prorated: 60,000 × 19/31 = 36,774.19 — under the exempt floor,
        // yet tax is on the 60,000 package: 1% × (60,000 − 50,000) = 100.
        expect(Number(slip.earnings[0].amount)).toBeCloseTo(36774.18, 1);
        expect(Number(taxLine(slip).amount)).toBe(100);
    });

    it('charges 400 on a 90,000 package with 2 days already deducted (HR Abdullah case)', () => {
        const slip = buildPayslipFromInputs({
            employee: mkEmp(FULL_MONTH),
            employmentTerm: term('90000'),
            assignments: [],
            payrollRun: mkRun(),
            taxRateRows: RATES,
            bridges: { attendanceRows: [{ date: new Date('2026-08-05T00:00:00Z'), status: 'ABSENT', day_credit: 0 }, { date: new Date('2026-08-06T00:00:00Z'), status: 'ABSENT', day_credit: 0 }] },
        });
        // Gross shrinks by 2 days; tax stays on the 90,000 package.
        expect(Number(taxLine(slip).amount)).toBe(400);
    });

    it('leaves the full-month employee byte-identical (no uplift)', () => {
        const slip = buildPayslipFromInputs({
            employee: mkEmp(FULL_MONTH),
            employmentTerm: term('60000'),
            assignments: [],
            payrollRun: mkRun(),
            taxRateRows: RATES,
        });
        expect(Number(taxLine(slip).amount)).toBe(100); // unchanged by N-21
    });

    it('does NOT uplift non-taxable earning types', () => {
        const slip = buildPayslipFromInputs({
            employee: mkEmp(PART_MONTH),
            employmentTerm: term('60000'),
            assignments: [{ earningType: { id: 1, name: 'Non-taxable allowance', isTaxable: false }, amount: '10000' }],
            payrollRun: mkRun(),
            taxRateRows: RATES,
        });
        // Package 60,000 still taxable-only → 100; the excluded allowance never
        // enters the base either prorated or uplifted.
        expect(Number(taxLine(slip).amount)).toBe(100);
    });
});

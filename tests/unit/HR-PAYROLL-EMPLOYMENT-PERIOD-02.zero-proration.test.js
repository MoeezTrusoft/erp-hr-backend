// HR-PAYROLL-EMPLOYMENT-PERIOD-02 — a proration factor of zero must pay zero.
//
// Found by the August dry-run, which showed Abdul Moiz Ahmed at "0%" and a full
// 25,000 gross on the same line.
//
// buildPayslipFromInputs gated proration on
//
//     const isProrated = prorationFactor > 0n && prorationFactor < 1_000_000n;
//
// so a factor of exactly zero fell through the guard and the base salary was
// paid IN FULL. The `> 0n` half was presumably meant to skip the work when
// there is nothing to prorate, but zero is the one case where proration matters
// most: it is somebody who was not employed for any part of this run.
//
// The dangerous shape is a leaver still carrying employment terms. Terms are a
// compensation record and outlive employment, so "has terms" must never imply
// "gets paid".
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const payrollRun = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T23:59:59.999Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};
const employmentTerm = { baseSalary: 30000, currency: 'PKR', payFrequency: 'MONTHLY' };

const build = (employmentPeriods, assignments = []) =>
    buildPayslipFromInputs({
        employee: { id: 1, employmentPeriods },
        employmentTerm,
        assignments,
        payrollRun,
        taxRateRows: [],
        bridges: {},
    });

// The live salary structure: basic 45%, then house 20 / transport 15 /
// medical 12.5 / utilities 7.5 as FIXED allowance assignments.
const allowance = (name, amount) => ({
    earningType: { id: name, name },
    amount,
    rate: null,
});

const gross = (slip) => Number(slip.grossAmount);

describe('HR-PAYROLL-EMPLOYMENT-PERIOD-02 zero proration', () => {
    it('pays nothing to someone whose employment ended before the run', () => {
        const slip = build([{ startDate: '2024-01-01', endDate: '2026-07-31' }]);

        expect(slip.prorationFactor).toBe(0);
        expect(gross(slip)).toBe(0);
    });

    it('pays nothing to someone who joins after the run ends', () => {
        const slip = build([{ startDate: '2026-09-07', endDate: null }]);

        expect(gross(slip)).toBe(0);
    });

    it('still pays a part-month leaver their part', () => {
        // The guard must not swing the other way and zero everyone.
        const slip = build([{ startDate: '2024-01-01', endDate: '2026-08-19' }]);

        expect(gross(slip)).toBeCloseTo(30000 * (19 / 31), 0);
    });

    it('pays a full month when employed throughout', () => {
        const slip = build([{ startDate: '2024-01-01', endDate: null }]);

        expect(slip.prorationFactor).toBe(1);
        expect(gross(slip)).toBe(30000);
    });

    it('pays a full month when no period is on file at all', () => {
        const slip = build([]);

        expect(gross(slip)).toBe(30000);
    });

    it('prorates the ALLOWANCES too, not just the base salary', () => {
        // The August dry-run showed affan at "0%" and 13,750 gross — exactly the
        // 55% allowance share of a 25,000 package. Proration was applied to the
        // base only, so a leaver kept every allowance in full. The code's own
        // comment calls allowances "part of the contracted package"; if that is
        // true for charging a deducted day, it is true for paying the month.
        const slip = build(
            [{ startDate: '2024-01-01', endDate: '2026-07-31' }],
            [allowance('House Rent', 6000), allowance('Transport', 4500)],
        );

        expect(gross(slip)).toBe(0);
    });

    it('prorates allowances by the same fraction as the base', () => {
        const slip = build(
            [{ startDate: '2024-01-01', endDate: '2026-08-19' }],
            [allowance('House Rent', 6000)],
        );

        // (30000 base + 6000 allowance) × 19/31
        expect(gross(slip)).toBeCloseTo(36000 * (19 / 31), 0);
    });

    it('does not double-prorate a rate-based allowance', () => {
        // A percentage-of-gross allowance already follows the prorated base;
        // applying the factor again would shrink it twice.
        const slip = build(
            [{ startDate: '2024-01-01', endDate: '2026-08-19' }],
            [{ earningType: { id: 'pct', name: 'Pct' }, amount: null, rate: '0.10' }],
        );
        const prorabase = 30000 * (19 / 31);

        expect(gross(slip)).toBeCloseTo(prorabase * 1.1, 0);
    });

    it('describes a zero-pay line honestly rather than as a full month', () => {
        const slip = build([{ startDate: '2024-01-01', endDate: '2026-07-31' }]);
        const base = slip.earnings[0];

        expect(String(base.description)).toMatch(/prorated/i);
    });
});

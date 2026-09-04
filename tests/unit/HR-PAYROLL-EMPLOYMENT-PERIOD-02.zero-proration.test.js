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

const build = (employmentPeriods) =>
    buildPayslipFromInputs({
        employee: { id: 1, employmentPeriods },
        employmentTerm,
        assignments: [],
        payrollRun,
        taxRateRows: [],
        bridges: {},
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

    it('describes a zero-pay line honestly rather than as a full month', () => {
        const slip = build([{ startDate: '2024-01-01', endDate: '2026-07-31' }]);
        const base = slip.earnings[0];

        expect(String(base.description)).toMatch(/prorated/i);
    });
});

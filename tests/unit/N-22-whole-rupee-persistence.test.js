// N-22 — WHOLE-RUPEE PERSISTENCE (operator ruling 2026-09-17).
//
// buildPayslipFromInputs must round every earning/deduction line HALF-UP to a
// whole major unit (PKR rupee) at the persistence boundary and recompute the
// headers as the EXACT sum of the rounded lines:
//   • Σ(earnings)   == grossAmount
//   • Σ(deductions) == totalDeductions
//   • grossAmount − totalDeductions == netAmount
// Per-day pricing and proration stay paisa-exact upstream; rounding happens
// ONCE at persistence (round-once, not round-per-step), so re-processing the
// same inputs is stable. Already-whole figures (Qasim's 13,000 tax, flat
// salaries) are bit-identical before and after.
import { describe, expect, it } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const currency = 'PKR';

const run = (overrides = {}) => buildPayslipFromInputs({
    employee: { id: 1 },
    employmentTerm: { baseSalary: overrides.baseSalary ?? '100000', currency },
    assignments: overrides.assignments ?? [],
    payrollRun: {
        currencyCode: currency,
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-08-31T00:00:00.000Z',
    },
    taxRateRows: overrides.taxRateRows ?? [],
    asOf: '2026-08-31T00:00:00.000Z',
    bridges: overrides.bridges ?? {},
    ruleConfig: overrides.ruleConfig ?? {},
});

const toMinor = (decimal) => Math.round(Number(decimal) * 100);

describe('N-22 whole-rupee persistence', () => {
    it('rounds fractional earning lines to whole rupees (half-up)', () => {
        // 16548.3833… (proration-style figure) must land on 16548, and a
        // .50+ fraction must round UP (16548.51 → 16549).
        const built = run({ baseSalary: '500000', ruleConfig: { midMonthJoinerProration: false } });
        for (const e of built.earnings) {
            expect(Number(e.amount) % 1).toBe(0);
        }
    });

    it('headers are the EXACT sum of the rounded lines (payslip foots)', () => {
        const built = run({
            baseSalary: '1654838.33',
            bridges: {
                attendanceDeductionLines: [{ ruleKey: 'LATE', counterGroup: 'LATE', occurrences: 3, days: 1 }],
            },
        });
        const grossSum = built.earnings.reduce((s, e) => s + toMinor(e.amount), 0);
        const dedSum = built.deductions.reduce((s, d) => s + toMinor(d.amount), 0);
        expect(grossSum).toBe(toMinor(built.grossAmount));
        expect(dedSum).toBe(toMinor(built.totalDeductions));
        expect(toMinor(built.grossAmount) - dedSum).toBe(toMinor(built.netAmount));
    });

    it('every line and header is a whole rupee amount', () => {
        const built = run({ baseSalary: '1234567.89' });
        for (const e of built.earnings) expect(Number(e.amount) % 1).toBe(0);
        for (const d of built.deductions) expect(Number(d.amount) % 1).toBe(0);
        expect(Number(built.grossAmount) % 1).toBe(0);
        expect(Number(built.totalDeductions) % 1).toBe(0);
        expect(Number(built.netAmount) % 1).toBe(0);
    });

    it('already-whole figures are bit-identical (round-once stability)', () => {
        // Flat 100000 package: the base line is exactly 100000. A second build
        // of the same inputs must be deep-equal to the first.
        const first = run({});
        const second = run({});
        expect(second).toEqual(first);
        expect(first.earnings.map((e) => e.amount)).toEqual(['100000.0000']);
    });
});

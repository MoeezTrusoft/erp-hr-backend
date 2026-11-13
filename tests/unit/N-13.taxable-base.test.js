// N-13 — income tax must be computed on the TAXABLE base, not full gross.
//
// computeProgressiveTaxMinor was called with grossMinor — earning-type
// taxability (PayrollEarningType.isTaxable) was ignored entirely, so "500K
// salary, only 200K taxable" was un-expressable: the engine taxed the whole
// package. The taxable base is the sum of earning lines whose resolved type
// is not explicitly non-taxable (unknown → taxable, the earning-type default).
//
// Operator case (2026-09-11): Syed Qasim, Trusoft — 500K salary of which only
// 200K is taxable. Modeled as 200K base + a 300K allowance whose earning type
// carries isTaxable=false.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};

// simple progressive table in the TaxRate column shape (major units):
// 0–100,000 @ 0%, above 100,000 @ 10%.
const RATES = [
    { countryCode: 'PK', bracketMin: 0, bracketMax: 100000, rate: 0, effectiveFrom: '2026-01-01' },
    { countryCode: 'PK', bracketMin: 100000, bracketMax: null, rate: 0.1, effectiveFrom: '2026-01-01' },
];

const NON_TAXABLE = { earningType: { id: 9, name: 'Non-Taxable Allowance', isTaxable: false }, amount: 300000, rate: null };

const build = (assignments) => buildPayslipFromInputs({
    employee: { id: 480 },
    employmentTerm: { baseSalary: 200000, payFrequency: 'MONTHLY', currency: 'PKR' },
    assignments,
    payrollRun: AUGUST,
    taxRateRows: RATES,
    asOf: AUGUST.periodEnd,
    bridges: {},
    ruleConfig: {},
});

const tax = (slip) => {
    const line = slip.deductions.find((d) => d.code === 'INCOME_TAX');
    return line ? Number(line.amount) : 0;
};

describe('N-13 taxable base for income tax', () => {
    it('taxes only the taxable lines: 500K package, 200K taxable → tax on 200K', () => {
        // taxable 200,000: (200K − 100K) × 10% = 10,000. The bug taxes 500K → 40,000.
        const slip = build([NON_TAXABLE]);
        expect(Number(slip.grossAmount)).toBe(500000);
        expect(tax(slip)).toBeCloseTo(10000, 0);
    });

    it('taxable allowances (no isTaxable flag) are taxed as before', () => {
        // 200K base + 300K taxable allowance = 500K taxable → (500K−100K)×10% = 40,000.
        const slip = build([{ earningType: { id: 2, name: 'Taxable Allowance' }, amount: 300000, rate: null }]);
        expect(tax(slip)).toBeCloseTo(40000, 0);
    });

    it('isTaxable: true is identical to the default', () => {
        const slip = build([{ earningType: { id: 2, name: 'Allowance', isTaxable: true }, amount: 300000, rate: null }]);
        expect(tax(slip)).toBeCloseTo(40000, 0);
    });

    it('a fully non-taxable package pays zero income tax', () => {
        const slip = buildPayslipFromInputs({
            employee: { id: 1 },
            employmentTerm: { baseSalary: 0, payFrequency: 'MONTHLY', currency: 'PKR' },
            assignments: [NON_TAXABLE],
            payrollRun: AUGUST,
            taxRateRows: RATES,
            asOf: AUGUST.periodEnd,
            bridges: {},
            ruleConfig: {},
        });
        expect(Number(slip.grossAmount)).toBe(300000);
        expect(tax(slip)).toBe(0);
    });

    it('non-taxable earnings still count toward gross and the deducted-day basis', () => {
        // HR-PAYROLL-DEDUCTION-BASIS-01: a day costs the full package. A
        // non-taxable allowance is still contractual money.
        const slip = build([NON_TAXABLE]);
        expect(Number(slip.grossAmount)).toBe(500000);
        const lwp = buildPayslipFromInputs({
            employee: { id: 1 },
            employmentTerm: { baseSalary: 200000, payFrequency: 'MONTHLY', currency: 'PKR' },
            assignments: [NON_TAXABLE],
            payrollRun: AUGUST,
            taxRateRows: [],
            asOf: AUGUST.periodEnd,
            bridges: { lwpDays: 1 },
            ruleConfig: {},
        });
        const line = lwp.deductions.find((d) => String(d.description).startsWith('LWP'));
        expect(Number(line.amount)).toBeCloseTo(500000 / 31, 1);
    });
});

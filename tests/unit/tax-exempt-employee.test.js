// Per-employee tax exemption: basic salary is always taxable in the engine, so "split by the policy but untaxed" (Hassan
// Shehzad, 300,000, operator 2026-11-02) needs a person-level flag.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};
const RATES = [
    { countryCode: 'PK', bracketMin: 0, bracketMax: 100000, rate: 0, effectiveFrom: '2026-01-01' },
    { countryCode: 'PK', bracketMin: 100000, bracketMax: null, rate: 0.1, effectiveFrom: '2026-01-01' },
];
const SPLIT = [
    { earningType: { id: 27, name: 'HRA' }, amount: 60000, rate: null },
    { earningType: { id: 28, name: 'Conveyance' }, amount: 45000, rate: null },
    { earningType: { id: 29, name: 'Medical' }, amount: 37500, rate: null },
    { earningType: { id: 30, name: 'Utility' }, amount: 22500, rate: null },
];
const build = (employee) => buildPayslipFromInputs({
    employee,
    employmentTerm: { baseSalary: 135000, payFrequency: 'MONTHLY', currency: 'PKR' },
    assignments: SPLIT,
    payrollRun: AUGUST,
    taxRateRows: RATES,
    asOf: AUGUST.periodEnd,
    bridges: {},
    ruleConfig: {},
});
const tax = (slip) => Number(slip.deductions.find((d) => d.code === 'INCOME_TAX')?.amount ?? 0);

describe('tax_exempt employee', () => {
    it('pays the full 300,000 package with no income tax', () => {
        const slip = build({ id: 637, tax_exempt: true });
        expect(Number(slip.grossAmount)).toBe(300000);
        expect(tax(slip)).toBe(0);
    });
    it('the same package without the flag is taxed as before', () => {
        const slip = build({ id: 637, tax_exempt: false });
        expect(tax(slip)).toBeCloseTo(20000, 0);
    });
    it('a missing flag behaves like false', () => {
        expect(tax(build({ id: 637 }))).toBeCloseTo(20000, 0);
    });
});

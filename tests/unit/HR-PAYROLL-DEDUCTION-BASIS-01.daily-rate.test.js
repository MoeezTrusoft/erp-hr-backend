// HR-PAYROLL-DEDUCTION-BASIS-01 — what one deducted day actually costs.
//
// Operator spec, 2026-09-03:
//   "1 day deduction means the 100% salary (not just base salary) is divided
//    into days of this month (all days not just working days) e.g for august
//    100000 / 31 = 3225.8 PKR"
//   "add deductionBasis setting to Payroll Setup with BASIC | GROSS,
//    defaulting to GROSS"
//
// This replaces the previous rule, which divided BASE salary by a fixed 26
// working days for PK. Two things change and both move money:
//
//   * divisor: calendar days in the payroll period, not a fixed 26/22. August
//     (31 days) and February (28) now give different daily rates, as they
//     should — a monthly salary buys a month, however long it is.
//   * basis: the CONTRACTUAL total (base + fixed allowances), not base alone.
//     Salaries here are structured basic 45% + allowances 55%, so charging a
//     day against base alone would have under-deducted by more than half.
//
// GROSS deliberately means base + assignment-driven earnings, NOT the running
// gross. Overtime and employer benefit contributions are in gross by the time
// deductions are computed, and an employee who worked overtime must not thereby
// owe more for being absent a different day.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};
const FEBRUARY = {
    ...AUGUST,
    periodStart: new Date('2026-02-01T00:00:00.000Z'),
    periodEnd: new Date('2026-02-28T00:00:00.000Z'),
};

// basic 45% of 100,000; the four allowances make up the other 55%.
const ALLOWANCES = [
    { earningType: { id: 1, name: 'House Allowance' }, amount: 20000, rate: null },
    { earningType: { id: 2, name: 'Transport Allowance' }, amount: 15000, rate: null },
    { earningType: { id: 3, name: 'Medical Allowance' }, amount: 12500, rate: null },
    { earningType: { id: 4, name: 'Utilities Allowance' }, amount: 7500, rate: null },
];

const build = ({ payrollRun = AUGUST, ruleConfig, lwpDays = 1, assignments = ALLOWANCES } = {}) =>
    buildPayslipFromInputs({
        employee: { id: 1 },
        employmentTerm: { baseSalary: 45000, payFrequency: 'MONTHLY', currency: 'PKR' },
        assignments,
        payrollRun,
        taxRateRows: [],
        asOf: payrollRun.periodEnd,
        bridges: { lwpDays },
        ruleConfig,
    });

const lwpAmount = (slip) =>
    Number(slip.deductions.find((d) => String(d.description).startsWith('LWP')).amount);

describe('HR-PAYROLL-DEDUCTION-BASIS-01 one day costs salary / calendar days', () => {
    it('defaults to GROSS: a day in August is total salary / 31', () => {
        // 100,000 / 31 = 3225.8064...
        expect(lwpAmount(build())).toBeCloseTo(3225.81, 1);
    });

    it('uses the calendar length of the period, so February differs from August', () => {
        // 100,000 / 28 = 3571.43 — a monthly salary buys a month, however long.
        expect(lwpAmount(build({ payrollRun: FEBRUARY }))).toBeCloseTo(3571.43, 1);
    });

    it('BASIC charges against base salary alone', () => {
        // 45,000 / 31 = 1451.61
        expect(lwpAmount(build({ ruleConfig: { deductionBasis: 'BASIC' } }))).toBeCloseTo(1451.61, 1);
    });

    it('GROSS is more than twice BASIC under a 45% basic structure', () => {
        // The whole point of the setting: getting it wrong halves every penalty.
        const gross = lwpAmount(build({ ruleConfig: { deductionBasis: 'GROSS' } }));
        const basic = lwpAmount(build({ ruleConfig: { deductionBasis: 'BASIC' } }));
        expect(gross / basic).toBeCloseTo(100 / 45, 2);
    });

    it('an unknown basis falls back to GROSS rather than silently under-deducting', () => {
        expect(lwpAmount(build({ ruleConfig: { deductionBasis: 'NONSENSE' } }))).toBeCloseTo(3225.81, 1);
    });

    it('overtime does NOT inflate the daily rate', () => {
        // Working overtime must not make a different day of absence cost more.
        const withOt = buildPayslipFromInputs({
            employee: { id: 1 },
            employmentTerm: { baseSalary: 45000, payFrequency: 'MONTHLY', currency: 'PKR' },
            assignments: ALLOWANCES,
            payrollRun: AUGUST,
            taxRateRows: [],
            asOf: AUGUST.periodEnd,
            bridges: { lwpDays: 1, overtimeLines: [{ hours: 10, rate: 1.5, date: '2026-08-10' }] },
        });

        expect(lwpAmount(withOt)).toBeCloseTo(3225.81, 1);
    });

    it('counts calendar days, not milliseconds — an end-of-day periodEnd is still 31', () => {
        // Real callers pass periodEnd as 23:59:59.999. Differencing timestamps
        // gives 30.9999 days, which rounds to 31 and then +1 = 32 — so August
        // was being divided by 32 and every deduction came out ~3% light.
        const endOfDay = {
            ...AUGUST,
            periodEnd: new Date('2026-08-31T23:59:59.999Z'),
        };
        expect(lwpAmount(build({ payrollRun: endOfDay }))).toBeCloseTo(3225.81, 1);
    });

    it('half a day costs half', () => {
        expect(lwpAmount(build({ lwpDays: 0.5 }))).toBeCloseTo(1612.9, 1);
    });
});

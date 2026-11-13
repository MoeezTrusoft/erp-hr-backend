// HR-PAYROLL-EOBI-01 — Pakistani EOBI was computed as 1% of GROSS with no cap.
//
// The code read:
//     const eobiEmployee = grossMinor / 100n;   // 1%
// under a comment that claimed "capped at PKR 17,000 ceiling". The cap was
// never implemented. EOBI is a contribution to a state pension scheme assessed
// on a statutory wage base, not a percentage of whatever someone earns, so on a
// PKR 200,000 salary this over-deducted by an order of magnitude — PKR 2,000 a
// month instead of PKR 170.
//
// Two things are fixed here:
//   1. the ceiling is real, so the contribution stops rising with salary
//   2. it is per-tenant configuration, DISABLED by default
//
// Disabled by default is deliberate and was the operator's explicit
// instruction: code it, activate it for nobody. The exact statutory base and
// rate still need confirming with whoever files the returns, and a wrong
// default that silently applies is worse than no line at all. No payroll run
// exists in any tenant yet, so nothing regresses by leaving it off.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const payrollRun = {
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-30T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};

const build = ({ baseSalary, ruleConfig, countryCode }) =>
    buildPayslipFromInputs({
        employee: { id: 1 },
        employmentTerm: { baseSalary, payFrequency: 'MONTHLY', currency: 'PKR' },
        assignments: [],
        payrollRun: countryCode ? { ...payrollRun, countryCode } : payrollRun,
        taxRateRows: [],
        asOf: payrollRun.periodEnd,
        ruleConfig,
    });

const eobiOf = (payslip) =>
    payslip.deductions.find((d) => String(d.description).startsWith('EOBI'));

// Amounts leave the engine as fixed-precision STRINGS ("170.0000"), which is
// the point — money never becomes a float on the way out. Compare numerically.
const eobiAmount = (payslip) => Number(eobiOf(payslip).amount);

describe('HR-PAYROLL-EOBI-01 EOBI is off unless a tenant turns it on', () => {
    it('emits NO EOBI line by default', () => {
        // The guarantee behind "code it, do not activate it for any tenant".
        expect(eobiOf(build({ baseSalary: 200000 }))).toBeUndefined();
    });

    it('emits no EOBI line when explicitly disabled', () => {
        expect(eobiOf(build({ baseSalary: 200000, ruleConfig: { eobiEnabled: false } }))).toBeUndefined();
    });
});

describe('HR-PAYROLL-EOBI-01 the wage ceiling is real', () => {
    const enabled = { eobiEnabled: true };

    it('charges 1% of the ceiling, not 1% of gross, for a high earner', () => {
        // The bug: 1% of 200,000 = 2,000. Correct: 1% of the 17,000 ceiling = 170.
        expect(eobiAmount(build({ baseSalary: 200000, ruleConfig: enabled }))).toBe(170);
    });

    it('charges the same for two salaries above the ceiling', () => {
        // If this ever differs, the ceiling is not being applied.
        const low = eobiAmount(build({ baseSalary: 17000, ruleConfig: enabled }));
        const high = eobiAmount(build({ baseSalary: 900000, ruleConfig: enabled }));
        expect(low).toBe(high);
    });

    it('charges 1% of gross when gross is BELOW the ceiling', () => {
        expect(eobiAmount(build({ baseSalary: 10000, ruleConfig: enabled }))).toBe(100);
    });
});

describe('HR-PAYROLL-EOBI-01 rate and ceiling are configuration', () => {
    it('honours a different ceiling', () => {
        const slip = build({
            baseSalary: 200000,
            ruleConfig: { eobiEnabled: true, eobiWageCeilingMinor: 3700000 }, // PKR 37,000
        });
        expect(eobiAmount(slip)).toBe(370);
    });

    it('honours a different rate', () => {
        const slip = build({
            baseSalary: 200000,
            ruleConfig: { eobiEnabled: true, eobiEmployeeRatePct: 2 },
        });
        expect(eobiAmount(slip)).toBe(340);
    });
});

describe('HR-PAYROLL-EOBI-01 other countries are untouched', () => {
    it('still deducts FICA for a US employee regardless of the EOBI flag', () => {
        const slip = build({ baseSalary: 5000, countryCode: 'US', ruleConfig: { eobiEnabled: true } });

        expect(eobiOf(slip)).toBeUndefined();
        expect(slip.deductions.some((d) => String(d.description).includes('FICA'))).toBe(true);
    });
});

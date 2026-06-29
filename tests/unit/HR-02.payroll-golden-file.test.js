// HR-02 / HR-07 (Roadmap T-P4.1) — deterministic, versioned payroll engine.
//
// This REPLACES the deleted tests/unit/payrollCalculations.test.js, which
// mocked a COPY of `calculatePeriodSalary` and asserted against the mock (a
// green-on-fake-code anti-pattern). It instead drives the REAL exported engine
// functions from src/services/payrollService.js over a FIXED fixture and
// asserts:
//
//   1. DETERMINISM — the produced payslip equals a checked-in golden fixture
//      and is BYTE-IDENTICAL across two consecutive runs (JSON.stringify).
//   2. VERSIONED TAX — tax comes from the TaxRate table (progressive brackets),
//      NOT the old hardcoded 15%/5%. A rate change in the fixture changes the
//      result predictably, and the run records a reproducible ruleVersion.
//   3. EXACT MONEY — integer minor-unit math with round-half-up; a salary split
//      that would float-drift (semi-monthly /2 on an odd cent, and a third
//      split) reconciles to the cent (Σ shares === total).
//
// Pure functions only — no DB. The approval-gate + idempotency proof against
// the real Prisma engine lives in
// tests/integration/HR-02.payroll-approval-idempotency.test.js.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    calculatePeriodSalaryMinor,
    selectEffectiveTaxRates,
    computeProgressiveTaxMinor,
    computeRuleVersion,
    buildPayslipFromInputs,
} from '../../src/services/payrollService.js';
import { allocateEvenly, fromMajor, toMajor, sum } from '../../src/lib/money.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, '__fixtures__', 'HR-02.payslip.golden.json');

// ── Fixed fixture input ─────────────────────────────────────────────────────
// A US monthly employee earning 6543.21/mo with a 10% housing allowance
// (rate-based earning) and a flat 200.00 health deduction, taxed under a
// progressive 2-bracket US table effective for the run period.
const ASOF = new Date('2026-06-30T00:00:00.000Z');

const employee = { id: 4242 };

const employmentTerm = {
    baseSalary: 6543.21, // major units; would float-drift through /2 and /3
    payFrequency: 'MONTHLY',
    currency: 'USD',
};

const payrollRun = {
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    countryCode: 'US',
    currencyCode: 'USD',
};

const assignments = [
    {
        earningType: { id: 11, name: 'Housing Allowance' },
        deductionType: null,
        amount: null,
        rate: 0.1, // 10% of gross-so-far
    },
    {
        earningType: null,
        deductionType: { id: 21, name: 'Health Insurance' },
        amount: 200.0,
        rate: null,
    },
];

// Progressive US table effective for the period: 10% up to 5000 (major),
// 20% above 5000. Stored as the TaxRate row shape (major-unit brackets).
const taxRateRows = [
    { id: 1, countryCode: 'US', bracketMin: 0, bracketMax: 5000, rate: 0.1, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
    { id: 2, countryCode: 'US', bracketMin: 5000, bracketMax: null, rate: 0.2, effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
    // A future row that must NOT be selected for this period (effectiveFrom > asOf):
    { id: 3, countryCode: 'US', bracketMin: 0, bracketMax: null, rate: 0.99, effectiveFrom: new Date('2027-01-01'), effectiveTo: null },
    // A foreign-country row that must NOT be selected:
    { id: 4, countryCode: 'CA', bracketMin: 0, bracketMax: null, rate: 0.5, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
];

const buildFixturePayslip = () =>
    buildPayslipFromInputs({
        employee,
        employmentTerm,
        assignments,
        payrollRun,
        taxRateRows,
        asOf: ASOF,
    });

describe('HR-02 deterministic versioned payroll engine — golden file', () => {
    it('produces a payslip BYTE-IDENTICAL to the checked-in golden, and stable across two runs', () => {
        const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));

        const run1 = buildFixturePayslip();
        const run2 = buildFixturePayslip();

        // Determinism: two consecutive runs are byte-identical.
        expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
        // Regression: equals the checked-in golden, byte-for-byte.
        expect(JSON.stringify(run1)).toBe(JSON.stringify(golden));
    });

    it('selects ONLY the rate rows effective for the period + country (not future, not foreign)', () => {
        const selected = selectEffectiveTaxRates(taxRateRows, { countryCode: 'US', asOf: ASOF });
        const ids = selected.map((r) => r.id);
        expect(ids).toEqual([1, 2]); // sorted by bracketMin, US, effective now
        expect(ids).not.toContain(3); // future
        expect(ids).not.toContain(4); // foreign
    });

    it('records a reproducible ruleVersion that CHANGES when the rates change', () => {
        const v1 = computeRuleVersion(
            selectEffectiveTaxRates(taxRateRows, { countryCode: 'US', asOf: ASOF }),
            ASOF,
        );
        const v1Again = computeRuleVersion(
            selectEffectiveTaxRates(taxRateRows, { countryCode: 'US', asOf: ASOF }),
            ASOF,
        );
        expect(v1).toBe(v1Again); // reproducible

        const bumped = taxRateRows.map((r) => (r.id === 2 ? { ...r, rate: 0.25 } : r));
        const v2 = computeRuleVersion(
            selectEffectiveTaxRates(bumped, { countryCode: 'US', asOf: ASOF }),
            ASOF,
        );
        expect(v2).not.toBe(v1); // a rate change changes the version
    });

    it('tax comes from the table (progressive), NOT hardcoded 15%/5%', () => {
        // gross = base 6543.21 + 10% housing (654.321 -> 654.32 after the
        // gross-so-far rate). Progressive tax on the gross: 10% of first 5000
        // + 20% of the remainder. Assert it is NOT the legacy flat 20% (15+5).
        const slip = buildFixturePayslip();
        const grossMinor = fromMajor(slip.grossAmount);

        const legacyFlat = toMajor(Math.round(grossMinor * 0.2)); // old 15%+5%
        const taxLine = slip.deductions
            .filter((d) => /tax/i.test(d.description))
            .reduce((acc, d) => acc + d.amount, 0);

        expect(taxLine).toBeGreaterThan(0);
        expect(taxLine).not.toBeCloseTo(legacyFlat, 2);

        // And exactly the progressive figure computed by the engine helper.
        const sorted = selectEffectiveTaxRates(taxRateRows, { countryCode: 'US', asOf: ASOF });
        const expectedTaxMinor = computeProgressiveTaxMinor(grossMinor, sorted);
        expect(fromMajor(taxLine)).toBe(expectedTaxMinor);
    });

    it('a change to the bracket rate changes the resulting tax predictably', () => {
        const sorted = selectEffectiveTaxRates(taxRateRows, { countryCode: 'US', asOf: ASOF });
        const grossMinor = fromMajor(7000); // above the 5000 bracket
        const baseTax = computeProgressiveTaxMinor(grossMinor, sorted);

        const higher = sorted.map((r) => (r.bracketMin === 5000 ? { ...r, rate: 0.3 } : r));
        const higherTax = computeProgressiveTaxMinor(grossMinor, higher);

        // top bracket 0.20 -> 0.30 on the 2000 above 5000 => +200.00 => +20000 minor
        expect(higherTax - baseTax).toBe(fromMajor(200));
    });

    it('money is exact integer minor-units: a third-of-salary split reconciles to the cent', () => {
        // 6543.21 / 3 float-drifts; allocateEvenly must preserve every cent.
        const totalMinor = fromMajor(6543.21);
        const shares = allocateEvenly(totalMinor, 3);
        expect(shares).toHaveLength(3);
        expect(sum(shares)).toBe(totalMinor); // no cent lost
        // largest-remainder: first shares carry the extra cents deterministically
        expect(shares[0] - shares[2] === 0 || shares[0] - shares[2] === 1).toBe(true);
    });

    it('semi-monthly /2 on an odd-cent salary is total-preserving (no half-cent drift)', () => {
        // 6543.21 (654321 minor) halves to 654321/2 = 327160.5 — a half cent the
        // old Float `/ 2` would mishandle. allocateEvenly splits it into 327161 +
        // 327160 (first half carries the odd cent) so the TWO periods sum back to
        // the monthly figure EXACTLY. calculatePeriodSalaryMinor returns the
        // first (larger) half deterministically.
        const odd = { baseSalary: 6543.21, payFrequency: 'SEMI_MONTHLY', currency: 'USD' };
        const monthlyMinor = calculatePeriodSalaryMinor(
            { ...odd, payFrequency: 'MONTHLY' },
            payrollRun,
        );
        const [firstHalf, secondHalf] = allocateEvenly(monthlyMinor, 2);
        const periodFirstHalf = calculatePeriodSalaryMinor(odd, payrollRun);

        expect(periodFirstHalf).toBe(firstHalf); // deterministic: returns the first half
        expect(firstHalf + secondHalf).toBe(monthlyMinor); // total-preserving to the cent
        expect(firstHalf - secondHalf).toBe(1); // the odd cent lands on the first half
    });

    it('the payslip net reconciles: gross - totalDeductions === net, to the cent', () => {
        const slip = buildFixturePayslip();
        expect(fromMajor(slip.grossAmount) - fromMajor(slip.totalDeductions)).toBe(
            fromMajor(slip.netAmount),
        );
        // and gross equals the sum of its earning lines
        const earnMinor = sum(slip.earnings.map((e) => fromMajor(e.amount)));
        expect(earnMinor).toBe(fromMajor(slip.grossAmount));
        // and totalDeductions equals the sum of its deduction lines
        const dedMinor = sum(slip.deductions.map((d) => fromMajor(d.amount)));
        expect(dedMinor).toBe(fromMajor(slip.totalDeductions));
    });
});

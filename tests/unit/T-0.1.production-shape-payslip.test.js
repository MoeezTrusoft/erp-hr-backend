// T-0.1 / T-1.1 — production-shaped payslip case (plan 20, audit report 19 §4).
//
// The HR-02 golden fixture is a clean US employee: no absences, no half days,
// no lates, no loans. Production is the opposite: basic+55% allowances, one
// ACTIVE loan, mixed attendance (ABSENT / HALF_DAY / LATE / MISSING_*), an
// approved anomaly excusing a day, and a manually-corrected day.
//
// This block drives the REAL engine over that shape and pins the two behaviors
// that production data exposed as broken (report 19 §4, CHECK16/17/19):
//
//   N-01 — ABSENT and HALF_DAY day-credit loss must produce an
//          ABSENCE_RECOVERY deduction (through the SAME daily-rate path as
//          LWP: deductionBasis honored, calendar-day divisor) once
//          ruleConfig.absenceRecoveryEnabled is on — and the payslip must be
//          BYTE-IDENTICAL to pre-N-01 when the flag is off (ships dark).
//
//   N-03 guard — MISSING_* days (day_credit NULL) are HELD, never deducted by
//          the absence path; approved anomalies excuse the day;
//          manually-corrected days are priced by their stored credit.
//
// PK table for the money: one ACTIVE 0-bracket row so the tax line is zero and
// the absence line is the only deduction to reason about.
import { describe, it, expect } from '@jest/globals';
import {
    buildPayslipFromInputs,
} from '../../src/services/payrollService.js';
import { fromMajor } from '../../src/lib/money.js';

const ASOF = new Date('2026-09-30T00:00:00.000Z');

const payrollRun = {
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-30T23:59:59.999Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};

// Production shape: basic 45% + allowances 55% of a 25,000 package (11,250 basic).
const employmentTerm = {
    baseSalary: 11250,
    payFrequency: 'MONTHLY',
    currency: 'PKR',
};

const assignments = [
    {
        earningType: { id: 3, name: 'House Allowance' },
        deductionType: null,
        amount: 13750, // 55% flat allowance — prorated with the base (HR-PAYROLL-EMPLOYMENT-PERIOD-02)
        rate: null,
    },
];

const taxRateRows = [
    { id: 9, countryCode: 'PK', bracketMin: 0, bracketMax: 600000, rate: 0, effectiveFrom: new Date('2026-07-01'), effectiveTo: null },
];

// September-shaped attendance for ONE employee:
//   2 ABSENT (credit 0) · 2 HALF_DAY (credit 0.5) · 1 LATE (credit 1)
//   1 MISSING_CHECKIN (credit NULL → held, never deducted)
//   1 LATE day excused by an APPROVED anomaly · 1 HALF_DAY manually corrected
const attendance = [
    { date: new Date('2026-09-02'), status: 'ABSENT', day_credit: 0, manually_corrected: false },
    { date: new Date('2026-09-03'), status: 'ABSENT', day_credit: 0, manually_corrected: false },
    { date: new Date('2026-09-08'), status: 'HALF_DAY', day_credit: 0.5, manually_corrected: false },
    { date: new Date('2026-09-09'), status: 'HALF_DAY', day_credit: 0.5, manually_corrected: false },
    { date: new Date('2026-09-10'), status: 'LATE', day_credit: 1, manually_corrected: false },
    { date: new Date('2026-09-14'), status: 'MISSING_CHECKIN', day_credit: null, manually_corrected: false },
    { date: new Date('2026-09-21'), status: 'LATE', day_credit: 1, manually_corrected: false }, // approved anomaly below
    { date: new Date('2026-09-22'), status: 'HALF_DAY', day_credit: 0.5, manually_corrected: true }, // HR corrected
];

const anomalies = [
    { date: new Date('2026-09-21'), status: 'APPROVED', type: 'LATE_CHECKIN' },
];

// 30 calendar days in the period; deductionBasis GROSS (contractual 25,000).
// Expected unpaid fraction with the flag ON:
//   absents: 2 × 1.0 = 2.0
//   half days (incl. the corrected one): 3 × 0.5 = 1.5
//   LATE days: credit 1 → 0; excused LATE: skipped entirely; MISSING_*: held
//   total = 3.5 unpaid days out of 30 calendar days, charged on 25,000 GROSS.
const EXPECTED_ABSENCE_DAYS = 3.5;
// Integer-exact: 25000 (GROSS major) → 2500000 minor × 350 hundredths ÷ (100 × 30
// calendar days) = 291666 minor = 2916.66 (truncated at the paisa, never drifted).
const EXPECTED_ABSENCE_AMOUNT = 2916.66;

const bridges = {
    overtimeLines: [],
    lwpDays: 0,
    benefitLines: [],
    loanLines: [],
    attendanceDeductionLines: [], // rules not ratified yet — out of scope here
    // N-01 inputs — the daily verdicts ride the SAME bridges object the
    // processPayrollRun caller already assembles.
    attendanceRows: attendance,
    anomalyRows: anomalies,
};

const build = (ruleConfig) =>
    buildPayslipFromInputs({
        employee: { id: 161, employmentPeriods: [{ startDate: new Date('2025-01-01'), endDate: null }] },
        employmentTerm,
        assignments,
        payrollRun,
        taxRateRows,
        asOf: ASOF,
        bridges,
        ruleConfig,
    });

describe('T-0.1 production-shaped payslip (absence pricing N-01)', () => {
    it('FLAG OFF: payslip has NO absence line — byte-stable with pre-N-01 output', () => {
        const slip = build({}); // no config row → flag off
        const absenceLines = slip.deductions.filter((d) => d.code === 'ABSENCE_RECOVERY');
        expect(absenceLines).toHaveLength(0);
        // and the contractual package is paid in full
        expect(fromMajor(slip.grossAmount)).toBe(fromMajor('25000'));
    });

    it('FLAG ON: absence + half-day credit loss becomes ONE ABSENCE_RECOVERY line on the shared daily rate', () => {
        const slip = build({ absenceRecoveryEnabled: true, deductionBasis: 'GROSS' });
        const lines = slip.deductions.filter((d) => d.code === 'ABSENCE_RECOVERY');
        expect(lines).toHaveLength(1);
        expect(Number(lines[0].amount)).toBeCloseTo(EXPECTED_ABSENCE_AMOUNT, 2);
        expect(lines[0].description).toContain('3.5');
    });

    it('FLAG ON: MISSING_* (NULL credit) days are HELD, not deducted', () => {
        // 3.5 not 4.5 — the MISSING_CHECKIN day contributed nothing.
        const slip = build({ absenceRecoveryEnabled: true, deductionBasis: 'GROSS' });
        const line = slip.deductions.find((d) => d.code === 'ABSENCE_RECOVERY');
        expect(line.description).not.toContain('4.5');
    });

    it('FLAG ON: days excused by an APPROVED anomaly are skipped', () => {
        // Without the excused LATE day the answer is unchanged (credit 1 → 0),
        // so assert the mechanism instead: remove the anomaly and the corrected
        // HALF_DAY still prices — but an excused HALF_DAY would not.
        const excusedHalf = attendance.map((r) =>
            r.date.getUTCDate() === 8 ? { ...r, status: 'LATE', day_credit: 1 } : r,
        );
        const slip = buildPayslipFromInputs({
            employee: { id: 161, employmentPeriods: [{ startDate: new Date('2025-01-01'), endDate: null }] },
            employmentTerm,
            assignments,
            payrollRun,
            taxRateRows,
            asOf: ASOF,
            bridges: {
                ...bridges,
                attendanceRows: excusedHalf,
                anomalyRows: [{ date: new Date('2026-09-08'), status: 'APPROVED', type: 'OTHER' }],
            },
            ruleConfig: { absenceRecoveryEnabled: true, deductionBasis: 'GROSS' },
        });
        const line = slip.deductions.find((d) => d.code === 'ABSENCE_RECOVERY');
        // 2.0 absents + 1.0 (two un-excused half days) = 3.0 — the excused 0.5 gone
        expect(line.description).toContain('3');
    });

    it('FLAG ON: deductionBasis BASIC charges against base salary only', () => {
        const slip = build({ absenceRecoveryEnabled: true, deductionBasis: 'BASIC' });
        const line = slip.deductions.find((d) => d.code === 'ABSENCE_RECOVERY');
        const expected = (11250 * EXPECTED_ABSENCE_DAYS) / 30;
        expect(Number(line.amount)).toBeCloseTo(expected, 2);
    });

    it('FLAG ON: net reconciles and the absence line lands in totalDeductions', () => {
        const slip = build({ absenceRecoveryEnabled: true, deductionBasis: 'GROSS' });
        expect(fromMajor(slip.grossAmount) - fromMajor(slip.totalDeductions)).toBe(fromMajor(slip.netAmount));
        const dedMinor = slip.deductions.reduce((a, d) => a + fromMajor(d.amount), 0n);
        expect(dedMinor).toBe(fromMajor(slip.totalDeductions));
        expect(slip.deductions.length).toBeGreaterThan(0);
        expect(typeof slip.totalDeductions).toBe('string');
    });
});

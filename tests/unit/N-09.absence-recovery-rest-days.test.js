// N-09 — ABSENCE_RECOVERY must not price rest days.
//
// Operator law (2026-09-11): "our law is complete salary / days in month …
// and the deduction is this 1 day if any [violation]". A weekly off or holiday
// is not a violation — nobody is docked for a Sunday. But WEEKLY_OFF/HOLIDAY
// rows are stored with day_credit = 0 (the writer's rest-day convention), and
// the N-01 bridge summed (1 − credit) over EVERY row, so rest days were priced
// as unpaid days: HomeVision's August carried ~140 phantom days ≈ PKR 246k.
//
// The bridge must skip non-working statuses entirely — only PRESENT/LATE/
// HALF_DAY/ABSENT/MISSING_* rows carry payroll meaning. HALF_DAY (0.5) and
// ABSENT (0) are the real credit-loss days; NULL credit stays held.
import { describe, it, expect } from '@jest/globals';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};

const day = (d, status, credit) => ({
    date: new Date(`2026-08-${String(d).padStart(2, '0')}T00:00:00.000Z`),
    status,
    day_credit: credit,
    manually_corrected: false,
});

// package: 100,000 PKR (45% base + 55% allowances) — one day = 100000/31.
const ALLOWANCES = [
    { earningType: { id: 1, name: 'House Allowance' }, amount: 20000, rate: null },
    { earningType: { id: 2, name: 'Transport Allowance' }, amount: 15000, rate: null },
    { earningType: { id: 3, name: 'Medical Allowance' }, amount: 12500, rate: null },
    { earningType: { id: 4, name: 'Utilities Allowance' }, amount: 7500, rate: null },
];

const build = (attendanceRows) => buildPayslipFromInputs({
    employee: { id: 1 },
    employmentTerm: { baseSalary: 45000, payFrequency: 'MONTHLY', currency: 'PKR' },
    assignments: ALLOWANCES,
    payrollRun: AUGUST,
    taxRateRows: [],
    asOf: AUGUST.periodEnd,
    bridges: { attendanceRows },
    ruleConfig: { absenceRecoveryEnabled: true },
});

const absenceLine = (slip) =>
    slip.deductions.find((d) => d.code === 'ABSENCE_RECOVERY' || String(d.description).startsWith('Absence recovery'));

describe('N-09 ABSENCE_RECOVERY skips rest days', () => {
    it('prices only HALF_DAY/ABSENT credit loss — WEEKLY_OFF and HOLIDAY rows are ignored', () => {
        // 4 weekly offs (credit 0) + 2 holidays (credit 0) + 1 ABSENT + 2 HALF_DAY
        // → real credit loss = 1×1.0 + 2×0.5 = 2.0 days → 100000 × 2 / 31 = 6451.61.
        // The bug prices 8.0 days (2580.64→ 100000×8/31 = 25806.45).
        const slip = build([
            day(1, 'WEEKLY_OFF', 0), day(2, 'WEEKLY_OFF', 0),
            day(3, 'WEEKLY_OFF', 0), day(4, 'WEEKLY_OFF', 0),
            day(5, 'HOLIDAY', 0), day(6, 'HOLIDAY', 0),
            day(7, 'PRESENT', 1), day(8, 'LATE', 1),
            day(9, 'ABSENT', 0),
            day(10, 'HALF_DAY', 0.5), day(11, 'HALF_DAY', 0.5),
        ]);
        expect(absenceLine(slip)).toBeTruthy();
        expect(Number(absenceLine(slip).amount)).toBeCloseTo(6451.61, 1);
    });

    it('a month of only rest days and full-credit days prices nothing', () => {
        const slip = build([
            day(1, 'WEEKLY_OFF', 0), day(2, 'HOLIDAY', 0),
            day(3, 'PRESENT', 1), day(4, 'LATE', 1),
        ]);
        expect(absenceLine(slip)).toBeFalsy();
    });

    it('ON_LEAVE rows are not credit loss (the leave bridge owns leave pricing)', () => {
        const slip = build([day(1, 'ON_LEAVE', 0), day(2, 'PRESENT', 1)]);
        expect(absenceLine(slip)).toBeFalsy();
    });

    it('NULL credit (MISSING_*) stays held — neither paid nor docked', () => {
        const slip = build([day(1, 'MISSING_CHECKIN', null), day(2, 'ABSENT', 0)]);
        // only the ABSENT day prices: 100000 × 1 / 31 = 3225.81
        expect(Number(absenceLine(slip).amount)).toBeCloseTo(3225.81, 1);
    });
});

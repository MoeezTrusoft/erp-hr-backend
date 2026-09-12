// N-17 — D1 POOLED_FLOOR: HR pools LATE / EARLY_CHECKOUT / MISSING_* into ONE
// 3:1 counter and floors the GRAND total ONCE — "2 days late = 0 days, 5 days
// late = 1 day" (operator law 2026-09-11). The per-group floor cannot express
// this: Zubair's "2 lates + 1 early" floors to 0 + 0 = 0, but HR's register
// charges 1 day. POOLED_FLOOR sums the raw fractional days across poolable
// rules, adds absence credit-loss, and floors the grand total once.
//
// Reference cases from HR's August register (Trusoft):
//   G. Rasool  4 lates            → 1.33 → 1 day
//   Zubair     2 lates + 1 early  → 1.00 → 1 day
//   Qasim      half-day + 1 late  → 0.83 → 0 days
//   M. Imran   2 absences + 1 late→ 2.33 → 2 days
import { describe, it, expect } from '@jest/globals';
import { countViolationDays, computeAttendanceDeductions } from '../../src/lib/attendanceDeduction.js';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const AUGUST = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    countryCode: 'PK',
    currencyCode: 'PKR',
};

// 500K package, all taxable → a deducted day = 500000 / 31.
const TERM = { baseSalary: 500000, payFrequency: 'MONTHLY', currency: 'PKR' };
const DAY_MINOR = (500000 * 100) / 31; // minor units per day ( paisa )

const RULES = [
    { ruleKey: 'LATE', counterGroup: 'VIOLATION_POOL', triggerCount: 3, deductionDays: 1, enabled: true },
    { ruleKey: 'EARLY_CHECKOUT', counterGroup: 'VIOLATION_POOL', triggerCount: 3, deductionDays: 1, enabled: true },
    { ruleKey: 'MISSING_CHECKIN', counterGroup: 'MISSING_PUNCH', triggerCount: 3, deductionDays: 1, enabled: true },
    { ruleKey: 'MISSING_CHECKOUT', counterGroup: 'MISSING_PUNCH', triggerCount: 3, deductionDays: 1, enabled: true },
];

const days = (slip) => {
    const line = slip.deductions.find((d) => d.code === 'ATTENDANCE_DEDUCTION');
    return line ? Number(line.amount) : 0;
};

const build = ({ attendance, anomalies = [], ruleConfig }) => buildPayslipFromInputs({
    employee: { id: 1, attendance, attendanceAnomalies: anomalies },
    employmentTerm: TERM,
    assignments: [],
    payrollRun: AUGUST,
    taxRateRows: [],
    asOf: AUGUST.periodEnd,
    bridges: {
        attendanceDeductionLines: computeAttendanceDeductions({
            violations: countViolationDays({ attendance, anomalies }),
            rules: RULES,
        }),
        attendanceRows: attendance,
        anomalyRows: anomalies,
    },
    ruleConfig,
});

// Attendance builders: dates inside August 2026.
const late = (d) => ({ date: new Date(`2026-08-${d}T00:00:00.000Z`), status: 'LATE', day_credit: 1 });
const early = (d) => ({ date: new Date(`2026-08-${d}T00:00:00.000Z`), status: 'EARLY_CHECKOUT', day_credit: 1 });
const absent = (d) => ({ date: new Date(`2026-08-${d}T00:00:00.000Z`), status: 'ABSENT', day_credit: 0 });
const half = (d) => ({ date: new Date(`2026-08-${d}T00:00:00.000Z`), status: 'HALF_DAY', day_credit: 0.5 });

describe('N-17 POOLED_FLOOR deduction mode (D1)', () => {
    it('pools across categories: 2 lates + 1 early = 1 day (Zubair)', () => {
        // EARLY_CHECKOUT is an anomaly type (no attendance status) — HR's
        // register shows Zubair's early departure as an anomaly on the day.
        const attendance = [late('03'), late('10')];
        const anomalies = [{ date: new Date('2026-08-17T00:00:00.000Z'), status: 'PENDING', type: 'EARLY_CHECKOUT' }];
        const slip = build({ attendance, anomalies, ruleConfig: { deductionBasis: 'POOLED_FLOOR' } });
        // raw = 3 × (1/3) = 1.0 → floor 1 day
        expect(days(slip)).toBeCloseTo(DAY_MINOR / 100, 0);
    });

    it('2 lates alone = 0 days (operator: "2 days late = 0")', () => {
        const attendance = [late('03'), late('10')];
        const slip = build({ attendance, ruleConfig: { deductionBasis: 'POOLED_FLOOR' } });
        expect(days(slip)).toBe(0);
    });

    it('5 violation days = 1 day (operator: "5 days late = 1")', () => {
        const attendance = [late('03'), late('10'), late('17'), late('24')];
        const anomalies = [{ date: new Date('2026-08-28T00:00:00.000Z'), status: 'REJECTED', type: 'EARLY_CHECKOUT' }];
        const slip = build({ attendance, anomalies, ruleConfig: { deductionBasis: 'POOLED_FLOOR' } });
        // raw = 5/3 = 1.67 → floor 1
        expect(days(slip)).toBeCloseTo(DAY_MINOR / 100, 0);
    });

    it('half-day + 1 late = 0 days (Qasim: fraction dropped)', () => {
        const attendance = [half('05'), late('12')];
        const slip = build({ attendance, ruleConfig: { deductionBasis: 'POOLED_FLOOR', absenceRecoveryEnabled: true } });
        // absence 0.5 + violation 0.33 = 0.83 → floor 0
        expect(days(slip)).toBe(0);
    });

    it('2 absences + 1 late = 2 days (M. Imran)', () => {
        const attendance = [absent('04'), absent('05'), late('12')];
        const slip = build({ attendance, ruleConfig: { deductionBasis: 'POOLED_FLOOR', absenceRecoveryEnabled: true } });
        // absence 2.0 + violation 0.33 = 2.33 → floor 2
        expect(days(slip)).toBeCloseTo((2 * DAY_MINOR) / 100, 0);
    });

    it('4 lates = 1 day (G. Rasool)', () => {
        const attendance = [late('03'), late('10'), late('17'), late('24')];
        const slip = build({ attendance, ruleConfig: { deductionBasis: 'POOLED_FLOOR' } });
        expect(days(slip)).toBeCloseTo(DAY_MINOR / 100, 0);
    });

    it('an APPROVED anomaly excuses its day from the pool', () => {
        const attendance = [late('03'), late('10')];
        const anomalies = [{ date: new Date('2026-08-17T00:00:00.000Z'), status: 'APPROVED', type: 'EARLY_CHECKOUT' }];
        const slip = build({ attendance, anomalies, ruleConfig: { deductionBasis: 'POOLED_FLOOR' } });
        // 2 surviving violations → 0.67 → floor 0
        expect(days(slip)).toBe(0);
    });

    it('legacy config (separate groups) does NOT pool across categories', () => {
        // Current PROD rule shape: LATE and EARLY_CHECKOUT each their own
        // counter (counterGroup null), MISSING_* share MISSING_PUNCH. Legacy
        // mode + this config floors each group separately, so 2 lates + 1 early
        // costs 0 — the divergence POOLED_FLOOR exists to fix.
        const SEPARATE = RULES.map((r) =>
            r.ruleKey === 'MISSING_CHECKIN' || r.ruleKey === 'MISSING_CHECKOUT'
                ? r
                : { ...r, counterGroup: null },
        );
        const attendance = [late('03'), late('10')];
        const anomalies = [{ date: new Date('2026-08-17T00:00:00.000Z'), status: 'PENDING', type: 'EARLY_CHECKOUT' }];
        const legacy = buildPayslipFromInputs({
            employee: { id: 1, attendance, attendanceAnomalies: anomalies },
            employmentTerm: TERM,
            assignments: [],
            payrollRun: AUGUST,
            taxRateRows: [],
            asOf: AUGUST.periodEnd,
            bridges: {
                attendanceDeductionLines: computeAttendanceDeductions({
                    violations: countViolationDays({ attendance, anomalies }),
                    rules: SEPARATE,
                }),
                attendanceRows: attendance,
                anomalyRows: anomalies,
            },
            ruleConfig: { absenceRecoveryEnabled: false },
        });
        expect(days(legacy)).toBe(0);
        expect(legacy.deductions.find((d) => d.code === 'ABSENCE_RECOVERY')).toBeUndefined();
    });

    it('legacy mode with a shared counterGroup pools that group only', () => {
        // The existing counterGroup feature: LATE+EARLY in ONE 3:1 counter →
        // 3 pooled days = 1 day even in legacy mode. POOLED_FLOOR goes further:
        // it adds the fractional contributions and floors the GRAND total.
        const attendance = [late('03'), late('10')];
        const anomalies = [{ date: new Date('2026-08-17T00:00:00.000Z'), status: 'PENDING', type: 'EARLY_CHECKOUT' }];
        const legacy = build({ attendance, anomalies, ruleConfig: { absenceRecoveryEnabled: false } });
        expect(days(legacy)).toBeCloseTo(DAY_MINOR / 100, 0);
    });

    it('POOLED_FLOOR floors the GRAND total: half-day + 1 late vs legacy 0.5 day', () => {
        const attendance = [half('05'), late('12')];
        // Legacy: violations floor to 0, but absence recovery charges the 0.5
        // half-day → 0.5 day docked.
        const legacy = build({ attendance, ruleConfig: { deductionBasis: 'GROSS', absenceRecoveryEnabled: true } });
        const legacyLine = legacy.deductions.find((d) => d.code === 'ABSENCE_RECOVERY');
        expect(Number(legacyLine.amount)).toBeCloseTo((0.5 * DAY_MINOR) / 100, 0);

        // POOLED_FLOOR: 0.5 + 0.33 = 0.83 → floor 0 → nothing docked (Qasim).
        const pooled = build({ attendance, ruleConfig: { deductionBasis: 'POOLED_FLOOR', absenceRecoveryEnabled: true } });
        expect(days(pooled)).toBe(0);
        expect(pooled.deductions.find((d) => d.code === 'ABSENCE_RECOVERY')).toBeUndefined();
    });
});

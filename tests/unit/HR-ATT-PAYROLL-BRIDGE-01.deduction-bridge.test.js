// HR-ATT-PAYROLL-BRIDGE-01 — attendance violations → payslip deduction lines.
//
// Two pure halves, so no mocks and no database: the inputs ARE the fixtures.
//   1. countViolationDays  — stored attendance/anomaly rows → countable occurrences
//   2. computeAttendanceDeductions — occurrences + rules → deduction DAYS
// and then the money half, asserted through the REAL payslip engine so the
// day→money conversion cannot drift from the LWP one it shares.
import { describe, it, expect } from '@jest/globals';
import {
    countViolationDays,
    computeAttendanceDeductions,
} from '../../src/lib/attendanceDeduction.js';
import { buildPayslipFromInputs } from '../../src/services/payrollService.js';

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

const att = (iso, status, extra = {}) => ({
    date: day(iso),
    status,
    manually_corrected: false,
    ...extra,
});

const rule = (ruleKey, over = {}) => ({
    ruleKey,
    enabled: true,
    triggerCount: 1,
    deductionDays: 0.5,
    periodScope: 'PAY_PERIOD',
    maxDeductionDaysPerPeriod: null,
    counterGroup: null,
    ...over,
});

const keysOf = (violations) => violations.map((v) => `${v.ruleKey}@${v.day}`).sort();

// ─── counting ────────────────────────────────────────────────────────────────

describe('HR-ATT-PAYROLL-BRIDGE-01 countViolationDays', () => {
    it('maps stored attendance status to the matching rule key', () => {
        const v = countViolationDays({
            attendance: [
                att('2026-08-03', 'LATE'),
                att('2026-08-04', 'MISSING_CHECKIN'),
                att('2026-08-05', 'MISSING_CHECKOUT'),
                att('2026-08-06', 'PRESENT'),
                att('2026-08-07', 'HALF_DAY'),
                att('2026-08-08', 'ABSENT'),
            ],
        });

        expect(keysOf(v)).toEqual([
            'LATE@2026-08-03',
            'MISSING_CHECKIN@2026-08-04',
            'MISSING_CHECKOUT@2026-08-05',
        ]);
    });

    it('never counts a day HR corrected by hand', () => {
        const v = countViolationDays({
            attendance: [att('2026-08-03', 'LATE', { manually_corrected: true })],
        });
        expect(v).toEqual([]);
    });

    it('never counts a day excused by an APPROVED anomaly', () => {
        const v = countViolationDays({
            attendance: [att('2026-08-03', 'LATE'), att('2026-08-04', 'LATE')],
            anomalies: [
                { date: day('2026-08-03'), status: 'APPROVED', type: 'LATE_CHECKIN' },
                { date: day('2026-08-04'), status: 'PENDING', type: 'LATE_CHECKIN' },
            ],
        });
        expect(keysOf(v)).toEqual(['LATE@2026-08-04']);
    });

    it('counts a REJECTED anomaly day as DISAPPROVED_LEAVE, once per day', () => {
        const v = countViolationDays({
            anomalies: [
                { date: day('2026-08-10'), status: 'REJECTED', sourceKind: 'LEAVE_REQUEST' },
                { date: day('2026-08-10'), status: 'REJECTED', sourceKind: 'REGULARIZATION' },
            ],
        });
        expect(keysOf(v)).toEqual(['DISAPPROVED_LEAVE@2026-08-10']);
    });

    it('is deterministic in output order', () => {
        const rows = [att('2026-08-05', 'LATE'), att('2026-08-01', 'MISSING_CHECKIN'), att('2026-08-03', 'LATE')];
        const a = countViolationDays({ attendance: rows });
        const b = countViolationDays({ attendance: [...rows].reverse() });
        expect(a).toEqual(b);
    });
});

// ─── scoring ─────────────────────────────────────────────────────────────────

describe('HR-ATT-PAYROLL-BRIDGE-01 computeAttendanceDeductions', () => {
    const lateDays = (n) =>
        Array.from({ length: n }, (_, i) => ({ ruleKey: 'LATE', day: `2026-08-${String(i + 1).padStart(2, '0')}` }));

    it('charges floor(occurrences / triggerCount) × deductionDays', () => {
        const lines = computeAttendanceDeductions({
            violations: lateDays(7),
            rules: [rule('LATE', { triggerCount: 3, deductionDays: 1 })],
        });
        expect(lines).toEqual([
            { ruleKey: 'LATE', counterGroup: null, occurrences: 7, days: 2 },
        ]);
    });

    it('costs nothing below the threshold', () => {
        expect(
            computeAttendanceDeductions({
                violations: lateDays(2),
                rules: [rule('LATE', { triggerCount: 3, deductionDays: 1 })],
            }),
        ).toEqual([]);
    });

    it('ignores a rule that is not enabled', () => {
        expect(
            computeAttendanceDeductions({
                violations: lateDays(5),
                rules: [rule('LATE', { enabled: false, triggerCount: 1, deductionDays: 1 })],
            }),
        ).toEqual([]);
    });

    it('pools a counterGroup into ONE counter', () => {
        // 2 missed check-ins + 1 missed check-out = 3 missed punches = 1 day.
        // Scored separately each would be sub-threshold and cost nothing.
        const lines = computeAttendanceDeductions({
            violations: [
                { ruleKey: 'MISSING_CHECKIN', day: '2026-08-01' },
                { ruleKey: 'MISSING_CHECKIN', day: '2026-08-02' },
                { ruleKey: 'MISSING_CHECKOUT', day: '2026-08-03' },
            ],
            rules: [
                rule('MISSING_CHECKIN', { counterGroup: 'MISSED_PUNCH', triggerCount: 3, deductionDays: 1 }),
                rule('MISSING_CHECKOUT', { counterGroup: 'MISSED_PUNCH', triggerCount: 3, deductionDays: 1 }),
            ],
        });
        expect(lines).toEqual([
            { ruleKey: 'MISSING_CHECKIN', counterGroup: 'MISSED_PUNCH', occurrences: 3, days: 1 },
        ]);
    });

    it('a pooled group bills one calendar day once', () => {
        const lines = computeAttendanceDeductions({
            violations: [
                { ruleKey: 'LATE', day: '2026-08-01' },
                { ruleKey: 'EARLY_CHECKOUT', day: '2026-08-01' },
                { ruleKey: 'LATE', day: '2026-08-02' },
            ],
            rules: [
                rule('LATE', { counterGroup: 'TIMEKEEPING', triggerCount: 1, deductionDays: 1 }),
                rule('EARLY_CHECKOUT', { counterGroup: 'TIMEKEEPING', triggerCount: 1, deductionDays: 1 }),
            ],
        });
        expect(lines).toEqual([
            { ruleKey: 'LATE', counterGroup: 'TIMEKEEPING', occurrences: 2, days: 2 },
        ]);
    });

    it('respects maxDeductionDaysPerPeriod', () => {
        const lines = computeAttendanceDeductions({
            violations: lateDays(20),
            rules: [rule('LATE', { triggerCount: 1, deductionDays: 1, maxDeductionDaysPerPeriod: 3 })],
        });
        expect(lines[0].days).toBe(3);
    });

    it('ignores violations with no configured rule', () => {
        expect(
            computeAttendanceDeductions({
                violations: [{ ruleKey: 'EARLY_CHECKOUT', day: '2026-08-01' }],
                rules: [rule('LATE', { triggerCount: 1, deductionDays: 1 })],
            }),
        ).toEqual([]);
    });
});

// ─── money ───────────────────────────────────────────────────────────────────

describe('HR-ATT-PAYROLL-BRIDGE-01 payslip bridge', () => {
    const employmentTerm = { baseSalary: '260000', payFrequency: 'MONTHLY', currency: 'PKR' };
    const payrollRun = {
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T00:00:00.000Z'),
        currencyCode: 'PKR',
        countryCode: 'PK',
    };
    const build = (bridges) =>
        buildPayslipFromInputs({
            employee: { id: 1 },
            employmentTerm,
            assignments: [],
            payrollRun,
            taxRateRows: [],
            bridges,
        });

    it('converts deduction DAYS to money with the LWP daily rate (PK = 26 working days)', () => {
        const slip = build({
            attendanceDeductionLines: [
                { ruleKey: 'LATE', counterGroup: null, occurrences: 3, days: 1 },
            ],
        });
        const line = slip.deductions.find((d) => d.description.startsWith('Attendance:'));
        expect(line).toBeDefined();
        // 260000.00 PKR = 26_000_000 minor; 26 working days ⇒ 1_000_000 minor/day.
        expect(line.amount).toBe('10000.0000');
        expect(line.description).toBe('Attendance: LATE (3 occurrences = 1 day)');
    });

    it('handles fractional deduction days', () => {
        const slip = build({
            attendanceDeductionLines: [
                { ruleKey: 'MISSING_CHECKOUT', counterGroup: 'MISSED_PUNCH', occurrences: 3, days: 0.5 },
            ],
        });
        const line = slip.deductions.find((d) => d.description.startsWith('Attendance:'));
        expect(line.amount).toBe('5000.0000');
        expect(line.description).toBe('Attendance: MISSED_PUNCH (3 occurrences = 0.5 days)');
    });

    it('uses the SAME daily rate as LWP — one day of LWP costs one day of attendance deduction', () => {
        const lwp = build({ lwpDays: 1 }).deductions.find((d) => d.description.startsWith('LWP'));
        const ded = build({
            attendanceDeductionLines: [{ ruleKey: 'LATE', counterGroup: null, occurrences: 1, days: 1 }],
        }).deductions.find((d) => d.description.startsWith('Attendance:'));
        expect(ded.amount).toBe(lwp.amount);
    });

    it('does not crash on a fractional LWP day (BigInt(1.5) used to throw)', () => {
        const line = build({ lwpDays: 0.5 }).deductions.find((d) => d.description.startsWith('LWP'));
        expect(line.amount).toBe('5000.0000');
    });

    it('adds nothing when there are no deduction lines', () => {
        const slip = build({});
        expect(slip.deductions.some((d) => d.description.startsWith('Attendance:'))).toBe(false);
    });

    it('skips zero-day lines rather than emitting a 0.00 deduction', () => {
        const slip = build({
            attendanceDeductionLines: [{ ruleKey: 'LATE', counterGroup: null, occurrences: 1, days: 0 }],
        });
        expect(slip.deductions.some((d) => d.description.startsWith('Attendance:'))).toBe(false);
    });
});

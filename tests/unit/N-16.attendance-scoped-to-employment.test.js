// N-16 — EMPLOYMENT-SCOPED ATTENDANCE: the absence bridge prices every
// attendance row in the period, but days outside an employment spell are not
// "unexcused work".
//
// Operator cases (2026-09-11):
//   - Obaid (Trusoft 493) terminated 2026-09-08. After termination the device
//     simply stops seeing him; absence marking would write ABSENT for Sep 9+
//     and absence recovery would dock him for days he was never employed.
//   - Muhammad Meesam (Trusoft 495) re-hired 2026-09-04 (term row; resumed
//     shift 2026-09-07). The Aug 21 – Sep 3 gap between spells is not an
//     absence — he was not on the books.
//
// Earnings stay governed by computeProrationFactor; this only scopes the
// attendance evidence.
import { describe, it, expect } from '@jest/globals';
import {
    employmentSpells,
    scopeAttendanceToEmployment,
    scopeAnomaliesToEmployment,
} from '../../src/services/payrollService.js';

const SEPT = new Date('2026-09-30T23:59:59.999Z');
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const row = (date, status = 'ABSENT', day_credit = 0) => ({ date: D(date), status, day_credit });

describe('N-16 attendance scoped to employment spells', () => {
    it('drops rows after termination (Obaid: out 2026-09-08)', () => {
        const employee = {
            employmentPeriods: [{ startDate: D('2026-08-01'), endDate: D('2026-09-08') }],
            attendance: [row('2026-09-05'), row('2026-09-08'), row('2026-09-11'), row('2026-09-12')],
        };
        expect(scopeAttendanceToEmployment(employee, SEPT)).toBe(2);
        expect(employee.attendance.map((r) => r.date.getUTCDate())).toEqual([5, 8]);
    });

    it('drops rows in the gap between spells (Meesam: out Aug 20, back Sep 4)', () => {
        const employee = {
            employmentPeriods: [
                { startDate: D('2026-01-01'), endDate: D('2026-08-20') },
                { startDate: D('2026-09-04'), endDate: null },
            ],
            attendance: [row('2026-08-19'), row('2026-08-25'), row('2026-09-02'), row('2026-09-05')],
        };
        expect(scopeAttendanceToEmployment(employee, SEPT)).toBe(2);
        expect(employee.attendance.map((r) => r.date.getUTCDate())).toEqual([19, 5]);
    });

    it('an open spell runs to the period end', () => {
        const employee = {
            employmentPeriods: [{ startDate: D('2026-01-01'), endDate: null }],
            attendance: [row('2026-09-30')],
        };
        expect(scopeAttendanceToEmployment(employee, SEPT)).toBe(0);
        expect(employee.attendance).toHaveLength(1);
    });

    it('employees with NO period history are untouched (steady-state majority)', () => {
        const employee = {
            employmentPeriods: [],
            attendance: [row('2026-09-01'), row('2026-09-15')],
        };
        expect(scopeAttendanceToEmployment(employee, SEPT)).toBe(0);
        expect(employee.attendance).toHaveLength(2);
    });

    it('handles boundary days inclusively (last day of a spell is priced)', () => {
        const employee = {
            employmentPeriods: [{ startDate: D('2026-09-01'), endDate: D('2026-09-08') }],
            attendance: [row('2026-09-01'), row('2026-09-08'), row('2026-09-09')],
        };
        expect(scopeAttendanceToEmployment(employee, SEPT)).toBe(1);
        expect(employee.attendance).toHaveLength(2);
    });

    it('is safe on missing/empty shapes', () => {
        expect(scopeAttendanceToEmployment(null, SEPT)).toBe(0);
        expect(scopeAttendanceToEmployment({ employmentPeriods: [] }, SEPT)).toBe(0);
        expect(
            scopeAttendanceToEmployment({ employmentPeriods: [{ startDate: D('2026-01-01'), endDate: null }] }, SEPT),
        ).toBe(0);
    });
});

// N-16b — EMPLOYMENT-SCOPED ANOMALY CASES: the priced cases (not only the
// attendance rows) must stop at the end of employment. Operator case: Amjad Ali
// (BOC 556) left 2026-10-10; his Oct 11-27 ABSENT cases were priced on a 10/31
// prorated package, the net went negative and the BOC October run failed.
const CASE = (date, type = 'ABSENT') => ({
    id: Number(date.replaceAll('-', '')),
    employeeId: 556,
    date: D(date),
    type,
    status: 'PENDING',
    rulesVersion: 2,
    evidenceState: 'ACTIVE',
});

describe('N-16b anomaly cases scoped to employment spells', () => {
    it('drops cases after termination (Amjad: out 2026-10-10)', () => {
        const employee = {
            employmentPeriods: [{ startDate: D('2025-08-08'), endDate: D('2026-10-10') }],
            attendanceAnomalies: [CASE('2026-10-09', 'MISSING_CHECKOUT'), CASE('2026-10-10'), CASE('2026-10-11'), CASE('2026-10-27')],
        };
        expect(scopeAnomaliesToEmployment(employee, SEPT)).toBe(2);
        expect(employee.attendanceAnomalies.map((a) => a.date.getUTCDate())).toEqual([9, 10]);
    });

    it('drops cases in the gap between spells', () => {
        const employee = {
            employmentPeriods: [
                { startDate: D('2026-01-01'), endDate: D('2026-08-20') },
                { startDate: D('2026-09-04'), endDate: null },
            ],
            attendanceAnomalies: [CASE('2026-08-25'), CASE('2026-09-05')],
        };
        expect(scopeAnomaliesToEmployment(employee, SEPT)).toBe(1);
        expect(employee.attendanceAnomalies).toHaveLength(1);
    });

    it('an open spell runs to the period end', () => {
        const employee = {
            employmentPeriods: [{ startDate: D('2026-01-01'), endDate: null }],
            attendanceAnomalies: [CASE('2026-09-30')],
        };
        expect(scopeAnomaliesToEmployment(employee, SEPT)).toBe(0);
        expect(employee.attendanceAnomalies).toHaveLength(1);
    });

    it('employees with NO period history are untouched (steady-state majority)', () => {
        const employee = {
            employmentPeriods: [],
            attendanceAnomalies: [CASE('2026-09-01'), CASE('2026-09-15')],
        };
        expect(scopeAnomaliesToEmployment(employee, SEPT)).toBe(0);
        expect(employee.attendanceAnomalies).toHaveLength(2);
    });

    it('is safe on missing/empty shapes', () => {
        expect(scopeAnomaliesToEmployment(null, SEPT)).toBe(0);
        expect(scopeAnomaliesToEmployment({ employmentPeriods: [] }, SEPT)).toBe(0);
        expect(scopeAnomaliesToEmployment({ employmentPeriods: [{ startDate: D('2026-01-01'), endDate: null }] }, SEPT)).toBe(0);
    });
});

// N-16c — the hire date is the spell when the employee has no period rows. Every
// ordinary joiner is in this shape: Aurangzaib (Homenet 640) was hired 2026-10-19
// and the evaluator had already written 15 and 18 Oct cases under his roster.
describe('N-16c employment spells fall back to the hire date', () => {
    const OCT = new Date('2026-10-31T23:59:59.999Z');
    it('opens one spell at the hire date with no periods', () => {
        const spells = employmentSpells({ hire_date: D('2026-10-19') }, OCT);
        expect(spells).toHaveLength(1);
        expect(spells[0].start.getUTCDate()).toBe(19);
        expect(spells[0].end).toBeNull();
    });

    it('drops cases dated before the hire date (Aurangzaib: hired 19 Oct)', () => {
        const employee = {
            hire_date: D('2026-10-19'),
            employmentPeriods: [],
            attendanceAnomalies: [CASE('2026-10-15', 'LATE_CHECKIN'), CASE('2026-10-18'), CASE('2026-10-19'), CASE('2026-10-28', 'LATE_CHECKIN')],
        };
        expect(scopeAnomaliesToEmployment(employee, OCT)).toBe(2);
        expect(employee.attendanceAnomalies.map((a) => a.date.getUTCDate())).toEqual([19, 28]);
    });

    it('drops attendance rows before the hire date', () => {
        const employee = {
            hire_date: D('2026-10-19'),
            employmentPeriods: [],
            attendance: [row('2026-10-15'), row('2026-10-18'), row('2026-10-19')],
        };
        expect(scopeAttendanceToEmployment(employee, OCT)).toBe(2);
        expect(employee.attendance.map((r) => r.date.getUTCDate())).toEqual([19]);
    });

    it('employment periods win over the hire date when both exist', () => {
        const spells = employmentSpells(
            { hire_date: D('2026-01-01'), employmentPeriods: [{ startDate: D('2026-09-04'), endDate: null }] },
            OCT,
        );
        expect(spells).toHaveLength(1);
        expect(spells[0].start.getUTCDate()).toBe(4);
    });

    it('no hire date and no periods leaves the employee untouched', () => {
        expect(employmentSpells({}, OCT)).toEqual([]);
        expect(employmentSpells(null, OCT)).toEqual([]);
    });
});

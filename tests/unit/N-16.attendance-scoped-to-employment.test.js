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
import { scopeAttendanceToEmployment } from '../../src/services/payrollService.js';

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

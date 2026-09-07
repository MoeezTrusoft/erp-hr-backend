// HR-ROSTER-03 — a roster that cannot be read must be refused, not stored.
//
// schedule_pattern is untyped JSON holding offDays, shift, shiftByDay,
// rotatingShifts, cycle and assorted notes. Nothing validates it, and every
// consumer degrades quietly on nonsense:
//
//   offDays: [8]      -> no such weekday, so the person works seven days
//   offDays: ["Sat"]  -> Number("Sat") is NaN, same result
//   shift: {from:"9"} -> the HH:MM regex fails, so the day has no window and
//                        every scan on it becomes unrostered
//   cycle without an anchor -> the rotation silently stops applying
//
// Each of those is a silent wrong answer that costs somebody a day's pay, and
// this month produced real instances: Akash's 07:00 start against a 07:30
// arrival, Zubair's missing cycle, Tanveer's wrong weekend. They were found by
// eye, against a workbook.
//
// So the pattern is checked where it is WRITTEN — changeRoster — rather than
// hoping every reader defends itself. Rejecting at the boundary is the only
// place a wrong roster is still cheap.
import { describe, it, expect } from '@jest/globals';
import { validateSchedulePattern } from '../../src/lib/schedulePattern.js';

const ok = (p) => validateSchedulePattern(p);

describe('HR-ROSTER-03 schedule pattern validation', () => {
    it('accepts the shapes actually in production', () => {
        expect(ok({ offDays: [6, 7], shift: { from: '09:00', to: '18:00' } }).valid).toBe(true);
        expect(ok({ offDays: [], rotatingShifts: [{ from: '10:00', to: '22:00' }],
            cycle: { days: 3, anchor: '2026-08-01', offIndex: 0 } }).valid).toBe(true);
        expect(ok({ offDays: [7], shift: { from: '07:30', to: '15:00' },
            shiftByDay: { 6: { from: '10:00', to: '13:00' } } }).valid).toBe(true);
    });

    it('rejects a weekday outside 1..7', () => {
        // ISO weekday: Monday=1 .. Sunday=7. An 8 silently means "never off".
        const r = ok({ offDays: [8], shift: { from: '09:00', to: '18:00' } });

        expect(r.valid).toBe(false);
        expect(r.errors.join(' ')).toMatch(/offDays/i);
    });

    it('rejects a weekday that is not a number', () => {
        // Number("Sat") is NaN, which compares false against every day, so the
        // employee works all seven.
        expect(ok({ offDays: ['Sat'], shift: { from: '09:00', to: '18:00' } }).valid).toBe(false);
    });

    it('rejects a malformed clock time', () => {
        // "9" fails the HH:MM match, leaving the day with no window at all.
        expect(ok({ offDays: [], shift: { from: '9', to: '18:00' } }).valid).toBe(false);
        expect(ok({ offDays: [], shift: { from: '25:00', to: '18:00' } }).valid).toBe(false);
        expect(ok({ offDays: [], shift: { from: '09:60', to: '18:00' } }).valid).toBe(false);
    });

    it('rejects a shift missing an end', () => {
        expect(ok({ offDays: [], shift: { from: '09:00' } }).valid).toBe(false);
    });

    it('rejects a rotation cycle that cannot be evaluated', () => {
        // Without an anchor there is no phase, so the rotation quietly stops
        // applying and every rest day reads as a working day.
        expect(ok({ rotatingShifts: [{ from: '10:00', to: '22:00' }],
            cycle: { days: 3, offIndex: 0 } }).valid).toBe(false);
        expect(ok({ rotatingShifts: [{ from: '10:00', to: '22:00' }],
            cycle: { days: 0, anchor: '2026-08-01', offIndex: 0 } }).valid).toBe(false);
        expect(ok({ rotatingShifts: [{ from: '10:00', to: '22:00' }],
            cycle: { days: 3, anchor: '2026-08-01', offIndex: 5 } }).valid).toBe(false);
    });

    it('rejects a per-weekday shift on an impossible day', () => {
        expect(ok({ shift: { from: '09:00', to: '18:00' },
            shiftByDay: { 9: { from: '10:00', to: '13:00' } } }).valid).toBe(false);
    });

    it('requires SOME way to know when the person works', () => {
        // No shift, no rotatingShifts: every scan is unrostered and every day
        // falls back to calendar grouping, which is the defect the whole
        // sessionisation rewrite existed to remove.
        expect(ok({ offDays: [6, 7] }).valid).toBe(false);
    });

    it('rejects a seven-day week outright', () => {
        // Off every day is not a roster, it is a mistake with a payroll cost.
        expect(ok({ offDays: [1, 2, 3, 4, 5, 6, 7],
            shift: { from: '09:00', to: '18:00' } }).valid).toBe(false);
    });

    it('reports every problem at once, not just the first', () => {
        const r = ok({ offDays: [8], shift: { from: '9' } });

        expect(r.errors.length).toBeGreaterThan(1);
    });

    it('treats a null pattern as invalid rather than empty', () => {
        expect(ok(null).valid).toBe(false);
        expect(ok(undefined).valid).toBe(false);
    });
});

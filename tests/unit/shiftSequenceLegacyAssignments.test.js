// Legacy imported assignments carry a start time without an end time. They inherit the roster's hours, so they must not
// make every roster write for that employee fail with "Shift times must be HH:MM" (HomeVision rotation, 2026-11-02).
import { describe, it, expect } from '@jest/globals';
import { validateEmployeeShiftSequence } from '../../src/services/shiftGovernance.service.js';

const roster = {
  effective_start_date: new Date('2026-10-06T00:00:00Z'),
  effective_end_date: null,
  schedule_pattern: { type: 'weekly', shift: { from: '10:00', to: '18:00' }, offDays: [6, 7], shiftHours: 8, crossesMidnight: false },
};
describe('validateEmployeeShiftSequence legacy assignments', () => {
  it('ignores an assignment that has a start time but no end time', () => {
    const legacy = { date: new Date('2026-08-10T00:00:00Z'), status: 'on_shift', fromTime: '09:57', toTime: null };
    expect(() => validateEmployeeShiftSequence([roster], [legacy])).not.toThrow();
  });
  it('still rejects a complete assignment with a malformed time', () => {
    const bad = { date: new Date('2026-10-07T00:00:00Z'), status: 'on_shift', fromTime: '9am', toTime: '18:00' };
    expect(() => validateEmployeeShiftSequence([roster], [bad])).toThrow();
  });
});

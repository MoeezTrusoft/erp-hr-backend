import { describe, it, expect } from '@jest/globals';
import { nonWorkingDayCredit } from '../../src/lib/attendanceReplay.js';
import { creditForStatus } from '../../src/services/attendanceImport.service.js';

// LEAVE-CREDIT-01 (operator, 2026-11-06). Rustam Khan (HomeVision 171) had an
// approved leave 16 Sep–16 Oct, yet every one of those days was stored
// ON_LEAVE with day_credit 0, and lib/attendanceDeduction prices Σ(1 − credit):
// the approved leave was deducted as a lost day. Approved leave is paid, so
// both writers of an ON_LEAVE row must credit it 1.
describe('an approved leave day is paid', () => {
  it('credits the replay verdict for APPROVED_LEAVE, and nothing else', () => {
    expect(nonWorkingDayCredit('APPROVED_LEAVE')).toBe(1);
    expect(nonWorkingDayCredit('WEEKLY_OFF')).toBe(0);
    expect(nonWorkingDayCredit('HOLIDAY')).toBe(0);
    expect(nonWorkingDayCredit(undefined)).toBe(0);
  });

  it('credits an imported ON_LEAVE row like leave.approve does', () => {
    expect(creditForStatus('ON_LEAVE')).toBe(1);
    // Untouched neighbours: the absent/rest mapping must not move with it.
    expect(creditForStatus('PRESENT')).toBe(1);
    expect(creditForStatus('ABSENT')).toBe(0);
    expect(creditForStatus('WEEKLY_OFF')).toBe(0);
    expect(creditForStatus('HOLIDAY')).toBe(0);
    expect(creditForStatus('MISSING_CHECKOUT')).toBeNull();
  });
});

// Operator decisions on attendance resolution requests:
//   • 2026-10-27 — the Level-1 LINE_MANAGER recommendation is PAUSED, so a raised
//     request lands straight in HR verification.
//   • 2026-10-28 — a request HR raises ON BEHALF is HR-verified by the act of
//     raising it, so it enters Management's decision directly.
import { describe, it, expect } from '@jest/globals';
import {
  isStagePaused,
  isVerifiedOnBehalf,
  pausedStagesFor,
  requiresLineManager,
  stageAfterSubmission,
} from '../../src/lib/approvalStagePolicy.js';

describe('Level-1 manager recommendation is paused for attendance', () => {
  it('skips the manager stage and needs no line manager configured', () => {
    expect(pausedStagesFor('ATTENDANCE')).toEqual(['LINE_MANAGER']);
    expect(isStagePaused('ATTENDANCE', 'LINE_MANAGER')).toBe(true);
    expect(stageAfterSubmission('ATTENDANCE')).toBe('HR');
    expect(requiresLineManager('ATTENDANCE')).toBe(false);
  });
  it('leaves every other kind on the full route', () => {
    for (const kind of ['LEAVE', 'OVERTIME', 'CLAIM', 'SHIFT_SWAP']) {
      expect(isStagePaused(kind, 'LINE_MANAGER')).toBe(false);
      expect(stageAfterSubmission(kind)).toBe('LINE_MANAGER');
      expect(requiresLineManager(kind)).toBe(true);
    }
  });
});

describe('HR raising on behalf is HR-verified', () => {
  it('applies to attendance resolution requests, claims and loans only', () => {
    for (const kind of ['ATTENDANCE', 'CLAIM', 'LOAN']) expect(isVerifiedOnBehalf(kind)).toBe(true);
    for (const kind of ['LEAVE', 'OVERTIME', 'SHIFT_SWAP', 'ATTENDANCE_CORRECTION'])
      expect(isVerifiedOnBehalf(kind)).toBe(false);
  });
});

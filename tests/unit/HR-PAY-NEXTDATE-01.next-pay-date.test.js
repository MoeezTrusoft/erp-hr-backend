// HR-PAY-NEXTDATE-01 — the dashboard countdown shows the next pay date from today.
//
// It used to count to the latest run's pay date and clamp at 0: on 28 Nov, with
// October paid on 10 Nov, it showed "28 Nov · 0 days left".
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: {} }));
const { computeNextPayDate } = await import('../../src/services/payrollDashboard.service.js');

const tenth = { payDateAnchor: 'FIXED_DATE', payDate: '2026-01-10T00:00:00.000Z' };

describe('HR-PAY-NEXTDATE-01 next pay date', () => {
  it('after this month\'s pay date, moves to next month', () => {
    const r = computeNextPayDate({ calendar: tenth, now: new Date('2026-11-28T09:00:00Z') });
    expect(r.payDate).toMatch(/^2026-12-(09|10|11)/);
    expect(r.days).toBeGreaterThan(10);
  });

  it('before this month\'s pay date, stays in this month', () => {
    const r = computeNextPayDate({ calendar: tenth, now: new Date('2026-12-02T09:00:00Z') });
    expect(r.payDate).toMatch(/^2026-12-/);
    expect(r.days).toBeGreaterThanOrEqual(0);
  });

  it('rolls December into January', () => {
    const r = computeNextPayDate({ calendar: tenth, now: new Date('2026-12-20T09:00:00Z') });
    expect(r.payDate).toMatch(/^2027-01-/);
  });
});

// HR-OT-ROSTER-01 — the team roster week reads the work-schedule roster, not
// only per-date shift rows (which exist only where HR assigned a day). With no
// rows at all the widget used to say "No roster data available".
import { jest, describe, it, expect } from '@jest/globals';

const roster = {
  employeeId: 1,
  effective_start_date: new Date('2026-10-01T00:00:00Z'),
  effective_end_date: null,
  schedule_pattern: { shift: { from: '09:00', to: '18:00' }, offDays: [6, 7] },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    shiftAssignment: { findMany: jest.fn(async () => []) },
    workSchedule: { findMany: jest.fn(async () => [roster]) },
    overtimeRequest: {
      findMany: jest.fn(async () => [{ employeeId: 1, date: new Date('2026-11-24T00:00:00Z'), hours: 2 }]),
    },
    employee: { findMany: jest.fn(async () => [{ id: 1, employee_code: 'EMP-0001', first_name: 'Ali' }]) },
  },
}));

const { getShiftRosterWeek } = await import('../../src/services/overtimeManager.service.js');

describe('roster week from rosters', () => {
  it('shows the roster shift on working days, off on weekends, and approved overtime', async () => {
    const { roster: rows } = await getShiftRosterWeek({ weekStart: '2026-11-23', employeeId: 1 }, 't1');
    expect(rows).toHaveLength(1);
    const day = (d) => rows[0].days.find((x) => x.date === d);
    expect(day('2026-11-24')).toMatchObject({ status: 'on_shift', fromTime: '09:00', toTime: '18:00', overtimeHours: 2 });
    expect(day('2026-11-28')).toMatchObject({ status: 'off', fromTime: null });
  });
});

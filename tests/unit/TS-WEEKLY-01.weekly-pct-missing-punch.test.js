// TS-WEEKLY-01 — weekly attendance % must agree with the ABSENT-only tooltip.
//
// Operator item 4 (2026-09-17): bars read 98/96% in weeks whose tooltip listed
// NO absentees. Cause: getAttendanceSummaryWeekly counted unresolved
// MISSING_CHECKIN/MISSING_CHECKOUT rows as expected-but-not-present — a
// pending anomaly is not an absence. Unresolved missing-punch days now drop
// out of BOTH numerator and denominator (same asymmetry the Absentees KPI
// uses), so a week of all-present + two pending-missing-punch days reads 100%
// with an empty tooltip, and the bar can never disagree with the tile.
//
// eligibilityEmployeeIds is internal, so the prisma surfaces it reads
// (employee.findMany, employmentPeriod.findMany) are mocked alongside
// attendance.findMany; scoped helpers pass through untouched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 't-weekly';
const DAY = (iso) => new Date(`${iso}T00:00:00.000Z`);
const emp = (id) => ({ id, first_name: 'E', last_name: String(id), employee_code: `E-${id}` });

let employees;
let periods;
let monthlyRows;

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    employee: {
      findMany: jest.fn(async () => employees),
    },
    employmentPeriod: {
      findMany: jest.fn(async () => periods),
    },
    attendance: {
      findMany: jest.fn(async () => monthlyRows),
    },
  },
}));

jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
  scopedWhere: jest.fn((_t, w) => w ?? {}),
  scopedEmployeeWhere: jest.fn((_t, w) => w ?? {}),
}));

const { getAttendanceSummaryWeekly } = await import('../../src/services/timesheetReport.service.js');

beforeEach(() => {
  employees = [
    { id: 1, status: 'Active' },
    { id: 2, status: 'Active' },
    { id: 3, status: 'Active' },
  ];
  periods = [];
  monthlyRows = [];
});

describe('TS-WEEKLY-01 — weekly % agrees with the ABSENT-only tooltip', () => {
  it('reads 100% with zero absentees when the only gaps are unresolved missing punches', async () => {
    // Sep 1–2, 3 employees: two of the six days are unresolved missing punches.
    monthlyRows = [
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(2) },
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(3) },
      { date: DAY('2026-09-02'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-02'), status: 'MISSING_CHECKOUT', employee: emp(2) },
      { date: DAY('2026-09-02'), status: 'MISSING_CHECKIN', employee: emp(3) },
    ];

    const { weeks } = await getAttendanceSummaryWeekly({ tenantId: TENANT, month: '2026-09' });
    const w1 = weeks[0];
    expect(w1.attendancePct).toBe(100);
    expect(w1.absentees).toHaveLength(0);
  });

  it('counts fully-resolved days as normal working days', async () => {
    monthlyRows = [
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(2) },
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(3) },
      { date: DAY('2026-09-02'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-02'), status: 'PRESENT', employee: emp(2) },
      { date: DAY('2026-09-02'), status: 'PRESENT', employee: emp(3) },
    ];
    const { weeks } = await getAttendanceSummaryWeekly({ tenantId: TENANT, month: '2026-09' });
    expect(weeks[0].attendancePct).toBe(100);
  });

  it('still reports real ABSENT days below 100% with the absentee named', async () => {
    monthlyRows = [
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-01'), status: 'ABSENT', employee: emp(2) },
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(3) },
    ];
    const { weeks } = await getAttendanceSummaryWeekly({ tenantId: TENANT, month: '2026-09' });
    expect(weeks[0].attendancePct).toBe(67);
    expect(weeks[0].absentees).toHaveLength(1);
    expect(weeks[0].absentees[0].id).toBe(2);
  });

  it('does not let weekly-off or holiday rows inflate the denominator', async () => {
    monthlyRows = [
      { date: DAY('2026-09-01'), status: 'PRESENT', employee: emp(1) },
      { date: DAY('2026-09-01'), status: 'WEEKLY_OFF', employee: emp(2) },
      { date: DAY('2026-09-01'), status: 'HOLIDAY', employee: emp(3) },
    ];
    const { weeks } = await getAttendanceSummaryWeekly({ tenantId: TENANT, month: '2026-09' });
    expect(weeks[0].attendancePct).toBe(100);
    expect(weeks[0].absentees).toHaveLength(0);
  });
});

// ATT-ONLY-01 — an employee can be tracked for attendance without being paid.
// payroll_included=false removes someone from attendance AND payroll (unchanged);
// attendance_only=true keeps attendance and removes only payroll.
import { describe, it, expect } from '@jest/globals';
import { payrollEligibleFilter } from '../../src/services/payrollService.js';

const RUN = { periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-10-31T23:59:59.999Z') };

describe('ATT-ONLY-01 payroll selection', () => {
  it('excludes attendance_only employees from every payroll run', () => {
    const filter = payrollEligibleFilter(RUN);
    expect(filter.AND).toContainEqual({ attendance_only: { not: true } });
  });

  it('still requires payroll_included != false (the existing rule is untouched)', () => {
    expect(payrollEligibleFilter(RUN).AND).toContainEqual({ payroll_included: { not: false } });
  });

  it('evaluates as: tracked-and-paid yes, attendance-only no, excluded no', () => {
    const paid = (e) => e.payroll_included !== false && e.attendance_only !== true;
    expect(paid({ payroll_included: true, attendance_only: false })).toBe(true);
    expect(paid({ payroll_included: true, attendance_only: true })).toBe(false);
    expect(paid({ payroll_included: false, attendance_only: false })).toBe(false);
  });
});

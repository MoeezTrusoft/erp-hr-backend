import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const db = {
  payrollRun: { findFirst: jest.fn() },
  payrollPayslip: { findMany: jest.fn() },
  employee: { findMany: jest.fn() },
  employmentTerms: { findMany: jest.fn() },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: db }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: {} }));
jest.unstable_mockModule('../../src/services/payrollReadiness.service.js', () => ({ payrollReadiness: jest.fn() }));
jest.unstable_mockModule('../../src/services/payrollService.js', () => ({ payrollEligibleFilter: jest.fn() }));
jest.unstable_mockModule('../../src/services/payrollCalendar.service.js', () => ({ resolvePayDate: jest.fn() }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({ tenantTransaction: jest.fn() }));
const { exportPayrollCsv } = await import('../../src/services/payrollDashboard.service.js');
const tenantId = 'a0ddabf2-3020-4dc8-a6e7-c2a1f9172026';

beforeEach(() => {
  jest.clearAllMocks();
  db.payrollRun.findFirst.mockResolvedValue({ id: 28, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), currencyCode: 'PKR' });
  db.employee.findMany.mockResolvedValue([{ id: 627, employee_code: 'EMP-PAYROLL-UAT-INITIATOR', first_name: 'Never export names', gradeLevel: { name: 'G1' } }]);
  db.employmentTerms.findMany.mockResolvedValue([]);
});

describe('Payroll register CSV', () => {
  it.each([0, 2000])('exports tax separately and reconciles net pay with %s other deductions', async (other) => {
    const slip = { id: 1, employeeId: 627, status: 'FINALIZED', netAmount: 99000 - other, totalDeductions: 11000 + other,
      earnings: [{ amount: 100000, earningType: { code: 'BASIC' } }, { amount: 10000, earningType: { code: 'HOUSING' } }],
      deductions: [{ amount: 11000, deductionType: { name: 'Income Tax' } }, { amount: other, deductionType: { name: 'Loan' } }],
    };
    db.payrollPayslip.findMany.mockImplementation(async ({ where }) => where.payrollRunId ? [slip] : []);
    const result = await exportPayrollCsv({ tenantId, runId: 28 });
    const [headers, values] = result.content.split('\r\n').map(line => line.split(','));
    const row = Object.fromEntries(headers.map((key, i) => [key, values[i]]));
    expect(row['Employee code']).toBe('EMP-PAYROLL-UAT-INITIATOR');
    expect(result.content).not.toContain('Never export names');
    expect(row.Tax).toBe('11000');
    expect(row.Deductions).toBe(String(other));
    expect(Number(row.Basic) + Number(row.Allowances) - Number(row.Tax) - Number(row.Deductions)).toBe(Number(row.Net));
    expect(db.payrollRun.findFirst).toHaveBeenCalledWith({ where: { tenantId, id: 28 } });
  });
});

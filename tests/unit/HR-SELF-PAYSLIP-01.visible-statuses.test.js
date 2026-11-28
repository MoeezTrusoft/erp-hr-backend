// HR-SELF-PAYSLIP-01 — hr://self/payslips and /api/self/payslips hide draft and
// held slips until payroll is finalized, like hr_my_payslips_list.
import { jest, describe, it, expect } from '@jest/globals';

const findMany = jest.fn(async () => []);
jest.unstable_mockModule('../../src/config/prisma.js', () => ({ default: { payrollPayslip: { findMany } } }));
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: { payrollPayslip: { findMany } } }));
const { listSelfPayslips } = await import('../../src/services/self.service.js');

describe('HR-SELF-PAYSLIP-01', () => {
  it('only finalized or distributed slips of the acting employee', async () => {
    await listSelfPayslips({ user: { employeeId: 7, tenantId: 't1' } });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ employeeId: 7, status: { in: ['FINALIZED', 'DISTRIBUTED'] } });
  });
});

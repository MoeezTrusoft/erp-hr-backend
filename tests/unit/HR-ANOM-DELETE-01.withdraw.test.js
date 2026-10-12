// The attached anomaly rules retire legacy deletion for every caller.
// A DELETE permission must never erase a generated case or its payroll audit.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const prismaMock = {
  attendanceAnomaly: { findFirst: jest.fn(), delete: jest.fn() },
  attendanceAnomalyApproval: { deleteMany: jest.fn() },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({
  tenantTransaction: async (_client, fn) => fn(prismaMock),
}));
const { deleteAnomaly } = await import('../../src/services/attendanceAnomaly.service.js');
beforeEach(() => jest.clearAllMocks());

describe('retired anomaly withdrawal cannot bypass case history', () => {
  it.each([
    ['subject employee', 90, false],
    ['on-behalf filer', 214, false],
    ['unrelated employee', 999, false],
    ['HR/admin with DELETE permission', 999, true],
  ])('rejects %s without touching attendance or approvals', async (_role, requesterEmployeeId, requesterCanDeleteAny) => {
    await expect(deleteAnomaly({
      tenantId: 'tenant-A', id: 55, requesterEmployeeId, requesterCanDeleteAny,
    })).rejects.toMatchObject({ status: 410 });
    expect(prismaMock.attendanceAnomaly.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.attendanceAnomaly.delete).not.toHaveBeenCalled();
    expect(prismaMock.attendanceAnomalyApproval.deleteMany).not.toHaveBeenCalled();
  });
});

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const prismaMock = { leaveRequest: { create: jest.fn() } };
const listWorkingDates = jest.fn();
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({ tenantTransaction: async (p, fn) => fn(p) }));
jest.unstable_mockModule('../../src/services/leave.service.js', () => ({ listWorkingDates }));
const { requestLeave } = await import('../../src/services/leaveReport.service.js');

const tenant = '40314ef4-0a81-4390-b631-b3ad3f21f523';
beforeEach(() => {
  jest.resetAllMocks();
  prismaMock.leaveRequest.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
});

describe('requestLeave (MCP path)', () => {
  it('writes one PENDING row per working date and totalDays equals that count', async () => {
    listWorkingDates.mockResolvedValue(['2099-03-02', '2099-03-05']);
    await requestLeave({ tenantId: tenant, employeeId: 7, startDate: '2099-03-02', endDate: '2099-03-05', reason: 'Family', createdById: 7 });
    expect(listWorkingDates).toHaveBeenCalledWith(7, new Date('2099-03-02'), new Date('2099-03-05'), tenant);
    const data = prismaMock.leaveRequest.create.mock.calls[0][0].data;
    expect(data.totalDays).toBe(2);
    expect(data.days.create).toEqual([
      { date: new Date('2099-03-02T00:00:00.000Z'), decision: 'PENDING', tenantId: tenant },
      { date: new Date('2099-03-05T00:00:00.000Z'), decision: 'PENDING', tenantId: tenant },
    ]);
  });
  it('refuses with the 409 when attendance setup is incomplete', async () => {
    listWorkingDates.mockRejectedValue(Object.assign(new Error('Complete attendance setup before calculating leave'), { status: 409 }));
    await expect(requestLeave({ tenantId: tenant, employeeId: 7, startDate: '2099-03-02', endDate: '2099-03-05' })).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.leaveRequest.create).not.toHaveBeenCalled();
  });
});

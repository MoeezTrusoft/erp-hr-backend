// Pure-function baseline tests plus the create-request day rows (HR-LEAVE-DAYS-01).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const prismaMock = {
    leaveRequest: { findMany: jest.fn(), create: jest.fn() },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({ tenantTransaction: async (p, fn) => fn(p) }));
jest.unstable_mockModule('../../src/utils/logs.js', () => ({ logAction: jest.fn() }));
jest.unstable_mockModule('../../src/services/hrDomainEvent.service.js', () => ({ enqueueHrDomainEvent: jest.fn() }));
jest.unstable_mockModule('../../src/services/hrEvents.js', () => ({ leaveApprovedEvent: jest.fn(), leaveRejectedEvent: jest.fn() }));
const wd = (iso, working) => [iso, { working }];
let workingDaysMap;
jest.unstable_mockModule('../../src/services/workingDay.service.js', () => ({ resolveWorkingDays: jest.fn(async () => workingDaysMap) }));

const { createLeaveRequest, listWorkingDates } = await import('../../src/services/leave.service.js');

describe('Leave Service', () => {
    it('should calculate working days correctly', () => {
        const startDate = new Date('2024-01-01');
        const endDate = new Date('2024-01-05');
        const timeDiff = endDate.getTime() - startDate.getTime();
        const daysDiff = timeDiff / (1000 * 3600 * 24) + 1;

        expect(daysDiff).toBe(5);
    });

    it('should handle leave balance calculations', () => {
        const totalLeave = 20;
        const usedLeave = 5;
        const remaining = totalLeave - usedLeave;

        expect(remaining).toBe(15);
    });
});

describe('leave request day rows', () => {
    const tenant = '40314ef4-0a81-4390-b631-b3ad3f21f523';
    beforeEach(() => {
        jest.clearAllMocks();
        prismaMock.leaveRequest.findMany.mockResolvedValue([]);
        prismaMock.leaveRequest.create.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
        workingDaysMap = new Map([wd('2099-03-02', true), wd('2099-03-03', true), wd('2099-03-04', false), wd('2099-03-05', true)]);
    });

    it('listWorkingDates returns only the working dates and refuses uncovered ones', async () => {
        await expect(listWorkingDates(7, new Date('2099-03-02'), new Date('2099-03-05'), tenant)).resolves.toEqual(['2099-03-02', '2099-03-03', '2099-03-05']);
        workingDaysMap = new Map([wd('2099-03-02', null)]);
        await expect(listWorkingDates(7, new Date('2099-03-02'), new Date('2099-03-02'), tenant)).rejects.toMatchObject({ status: 409 });
    });

    it('creating a request writes one PENDING day row per working date', async () => {
        await createLeaveRequest({ employeeId: 7, startDate: '2099-03-02', endDate: '2099-03-05', reason: 'Family' }, 7, tenant);
        const data = prismaMock.leaveRequest.create.mock.calls[0][0].data;
        expect(data.totalDays).toBe(3);
        expect(data.days.create).toEqual([
            { date: new Date('2099-03-02T00:00:00.000Z'), decision: 'PENDING', tenantId: tenant },
            { date: new Date('2099-03-03T00:00:00.000Z'), decision: 'PENDING', tenantId: tenant },
            { date: new Date('2099-03-05T00:00:00.000Z'), decision: 'PENDING', tenantId: tenant },
        ]);
    });

    it('picked dates (a range and gaps) are the only day rows; the request spans first to last', async () => {
        workingDaysMap = new Map([wd('2099-03-02', true), wd('2099-03-03', true), wd('2099-03-04', true), wd('2099-03-05', true), wd('2099-03-06', true)]);
        await createLeaveRequest({ employeeId: 7, dates: ['2099-03-06', '2099-03-02', '2099-03-03', '2099-03-02'], reason: 'Family' }, 7, tenant);
        const data = prismaMock.leaveRequest.create.mock.calls[0][0].data;
        expect(data.startDate).toEqual(new Date('2099-03-02'));
        expect(data.endDate).toEqual(new Date('2099-03-06'));
        expect(data.totalDays).toBe(3);
        expect(data.days.create.map((d) => d.date.toISOString().slice(0, 10))).toEqual(['2099-03-02', '2099-03-03', '2099-03-06']);
    });

    it('picked non-working days are skipped; a bad date or no working day is refused', async () => {
        await createLeaveRequest({ employeeId: 7, dates: ['2099-03-02', '2099-03-04'] }, 7, tenant); // 04 is off
        expect(prismaMock.leaveRequest.create.mock.calls[0][0].data.totalDays).toBe(1);
        prismaMock.leaveRequest.create.mockClear();
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-03-04'] }, 7, tenant)).rejects.toThrow(/No working days/);
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-3-2'] }, 7, tenant)).rejects.toMatchObject({ status: 400 });
        expect(prismaMock.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('overlap is by date: a request for the gap between two others is allowed, a shared date is not', async () => {
        workingDaysMap = new Map([wd('2099-03-02', true), wd('2099-03-03', true), wd('2099-03-04', true), wd('2099-03-05', true), wd('2099-03-06', true)]);
        const existing = { startDate: new Date('2099-03-02'), endDate: new Date('2099-03-06'), days: [
            { date: new Date('2099-03-02'), decision: 'PENDING' }, { date: new Date('2099-03-06'), decision: 'PENDING' }, { date: new Date('2099-03-03'), decision: 'REJECTED' }] };
        prismaMock.leaveRequest.findMany.mockResolvedValue([existing]);
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-03-04'] }, 7, tenant)).resolves.toBeTruthy();
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-03-03'] }, 7, tenant)).resolves.toBeTruthy(); // rejected day is free
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-03-06'] }, 7, tenant)).rejects.toThrow(/overlapping/);
        // a request filed before day rows holds its whole range
        prismaMock.leaveRequest.findMany.mockResolvedValue([{ ...existing, days: [] }]);
        await expect(createLeaveRequest({ employeeId: 7, dates: ['2099-03-04'] }, 7, tenant)).rejects.toThrow(/overlapping/);
    });
});

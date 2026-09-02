// REQ-HR-DEPLOY-HARDENING-2026-09-02 §1b — bootstrap must fail CLOSED.
//
// bootstrapAttendanceData() decides whether to run a full XLSX import by
// counting existing attendance rows. The count was wrapped in
// `.catch(() => 0)`, so any failure — an HR-4030 deny-by-default, a pool
// timeout, a brief database blip during a rollout — reads as "there is no
// attendance data" and the import runs against a live database that is
// actually full.
//
// This is a prerequisite for going to 2 replicas: today one pod evaluates this
// at boot, and after 1b two pods would, doubling the exposure on every deploy.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const spawnMock = jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: (event, cb) => { if (event === 'close') cb(0); },
}));

const prismaMock = {
    employee: { count: jest.fn(async () => 12) },
    attendance: { count: jest.fn(async () => 0) },
};

jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock }));
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));

const { bootstrapAttendanceData } = await import('../../src/services/attendance.bootstrap.service.js');

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.employee.count.mockResolvedValue(12);
    prismaMock.attendance.count.mockResolvedValue(0);
    delete process.env.ATTENDANCE_BOOTSTRAP_ENABLED;
});

describe('REQ-HR-DEPLOY-HARDENING-1b attendance bootstrap fails closed', () => {
    it('does NOT import when the attendance count query fails', async () => {
        // The exact shape of a deny-by-default: the query rejects rather than
        // returning a wrong number.
        prismaMock.attendance.count.mockRejectedValue(
            Object.assign(new Error('HR-4030: Attendance.count ran without a tenant context'), { code: 'HR-4030' }),
        );

        await bootstrapAttendanceData();

        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('does NOT import when the employee count query fails', async () => {
        prismaMock.employee.count.mockRejectedValue(new Error('pool timeout'));

        await bootstrapAttendanceData();

        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('still imports on a genuinely empty database', async () => {
        // Guards that fail closed are only useful if they do not also disable
        // the feature. A real zero must still bootstrap.
        await bootstrapAttendanceData();

        expect(spawnMock).toHaveBeenCalled();
    });

    it('skips when attendance rows already exist', async () => {
        prismaMock.attendance.count.mockResolvedValue(1574);

        await bootstrapAttendanceData();

        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('respects the disable flag', async () => {
        process.env.ATTENDANCE_BOOTSTRAP_ENABLED = 'false';

        await bootstrapAttendanceData();

        expect(spawnMock).not.toHaveBeenCalled();
        expect(prismaMock.attendance.count).not.toHaveBeenCalled();
    });
});

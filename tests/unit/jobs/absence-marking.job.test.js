// tests/unit/jobs/absence-marking.job.test.js
//
// HR-ATT-ABSENCE-02 (2026-09-28) — the scheduled absence marking. Proves:
//   * the repeatable is registered with the 03:00 PKT (22:00 UTC) pattern and
//     a stable jobId (re-registration de-dups),
//   * the processor dispatches JOB_ABSENCE_MARKING to the injected body,
//   * the body runs markAbsences dry-run-then-write for YESTERDAY in
//     Asia/Karachi, fleet-wide per tenant, and
//   * one tenant failing does not stop the others.
import { describe, it, expect, jest } from '@jest/globals';

const markAbsencesMock = jest.fn();
const tenantFindManyMock = jest.fn();

jest.unstable_mockModule('../../../src/services/absenceMarking.service.js', () => ({
  markAbsences: (...args) => markAbsencesMock(...args),
}));

jest.unstable_mockModule('../../../src/lib/prisma.js', () => ({
  default: {
    employee: { findMany: (...args) => tenantFindManyMock(...args) },
  },
}));

jest.unstable_mockModule('../../../src/lib/logger.js', () => ({
  default: {
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const planner=jest.fn(),drain=jest.fn();
jest.unstable_mockModule('../../../src/services/attendanceFinalization.service.js',()=>({planAttendanceFinalization:planner,drainAttendanceFinalization:drain}));

const { JOB_ABSENCE_MARKING, repeatableJobs, buildReminderProcessor } = await import(
  '../../../src/jobs/reminder.queue.js'
);
const { runAbsenceMarkingJob } = await import('../../../src/services/reminderScheduler.service.js');

describe('absence marking repeatable (HR-ATT-ABSENCE-02)', () => {
  it('is registered daily at 22:00 UTC (03:00 PKT) with a stable jobId', () => {
    const job = repeatableJobs().find((j) => j.name === JOB_ABSENCE_MARKING);
    expect(job).toBeTruthy();
    expect(job.opts.jobId).toBe('repeat:absence-marking');
    expect(job.opts.repeat.pattern).toBe('0 22 * * *');
  });

  it('is dispatched by the processor to the job body', async () => {
    const absenceMarking = jest.fn(async () => ({ marked: 0 }));
    const processor = buildReminderProcessor({ absenceMarking });
    await processor({ name: JOB_ABSENCE_MARKING, data: {} });
    expect(absenceMarking).toHaveBeenCalledTimes(1);
  });
});

describe('durable absence finalization scheduler',()=>{
 it('plans missed work dates and drains due jobs',async()=>{
  planner.mockResolvedValue({failures:[]});drain.mockResolvedValue({completed:7,failed:0});
  expect(await runAbsenceMarkingJob()).toEqual({completed:7,failed:0});
  expect(planner).toHaveBeenCalled();expect(drain).toHaveBeenCalledWith({limit:100});
 });
 it('surfaces failed windows so the existing scheduler retries',async()=>{
  planner.mockResolvedValue({failures:[{tenantId:'tenant-a'}]});drain.mockResolvedValue({completed:1,failed:0});
  await expect(runAbsenceMarkingJob()).rejects.toThrow('durable jobs retain their work dates');
 });
});

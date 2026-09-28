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

describe('runAbsenceMarkingJob', () => {
  beforeEach(() => {
    markAbsencesMock.mockReset();
    tenantFindManyMock.mockReset();
    // The tenant universe is derived from Employee rows ({ tenant_id }).
    tenantFindManyMock.mockResolvedValue([
      { tenant_id: 'tenant-a' },
      { tenant_id: 'tenant-b' },
    ]);
    markAbsencesMock.mockResolvedValue({ marked: 0 });
  });

  it('runs dry-run then write for yesterday in Asia/Karachi, per tenant', async () => {
    const { marked } = await runAbsenceMarkingJob();

    // Two calls per tenant: the dry-run plan, then the explicit write run.
    expect(markAbsencesMock).toHaveBeenCalledTimes(4);
    for (const call of markAbsencesMock.mock.calls) {
      const [{ from, to }] = call;
      expect(from).toBe(to);
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The window is YESTERDAY in Karachi: when this test runs, today's key
      // in Karachi is never the window (the 24h shift guarantees it).
      const todayKey = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      expect(from).not.toBe(todayKey);
    }

    // Dry run before write, per tenant.
    expect(markAbsencesMock.mock.calls.filter((c) => c[0].dryRun === true).length).toBe(2);
    expect(markAbsencesMock.mock.calls.filter((c) => c[0].dryRun === false).length).toBe(2);
    expect(marked).toBe(0);
  });

  it('sums marked rows across tenants', async () => {
    markAbsencesMock.mockImplementation(async ({ tenantId, dryRun }) => {
      if (dryRun) return { marked: 0 };
      return { marked: tenantId === 'tenant-a' ? 3 : 1 };
    });

    const { marked } = await runAbsenceMarkingJob();
    expect(marked).toBe(4);
  });

  it('one failing tenant does not stop the others', async () => {
    markAbsencesMock.mockImplementation(async ({ tenantId, dryRun }) => {
      if (tenantId === 'tenant-a') throw new Error('db blip');
      if (dryRun) return { marked: 0 };
      return { marked: 2 };
    });

    const summary = await runAbsenceMarkingJob();
    expect(summary.tenants).toBe(2);
    expect(summary.marked).toBe(2); // only tenant-b contributed
  });
});

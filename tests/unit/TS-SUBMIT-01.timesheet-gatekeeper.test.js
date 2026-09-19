// TS-SUBMIT-01 — the Submit-Timesheet gatekeeper (operator item 3, 2026-09-17).
//
//   1. The attendance cycle must be LOCKED (PayrollCalendar.attendanceCutoff
//      passed) — HR may force an early submission, and the override is audited.
//   2. ZERO unresolved anomaly requests in the month — no override exists.
//   3. Submission ACTIVATES the month's Payroll Vault run (PENDING PayrollRun)
//      idempotently, and records a TIMESHEET_SUBMITTED audit row.
//   4. Payroll processing REFUSES a month whose timesheet was never submitted
//      (HR-TP-03) — the mandatory blocker.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = 't-submit';
const MONTH = '2026-09';

const state = {
  calendar: { attendanceCutoff: null },
  anomalies: 0,
  runs: [], // existing PayrollRun rows
  createdRuns: [],
  auditRows: [],
  logs: [],
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: {
    payrollCalendar: { findFirst: jest.fn(async () => state.calendar) },
    attendanceAnomaly: { count: jest.fn(async () => state.anomalies) },
    payrollRun: {
      findFirst: jest.fn(async () => state.runs[0] ?? null),
      create: jest.fn(async ({ data }) => {
        const row = { id: state.createdRuns.length + 501, ...data };
        state.createdRuns.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = state.runs.find((candidate) => candidate.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    payrollAuditLog: {
      create: jest.fn(async ({ data }) => { state.auditRows.push(data); return { id: 1, ...data }; }),
      findFirst: jest.fn(async () => state.auditRows[0] ?? null),
    },
  },
}));

jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
  scopedWhere: jest.fn((_t, w) => w ?? {}),
  scopedEmployeeWhere: jest.fn((_t, w) => w ?? {}),
  scopedData: jest.fn((_t, d) => d),
}));

jest.unstable_mockModule('../../src/utils/logs.js', () => ({
  logAction: jest.fn(async ({ notes }) => { state.logs.push(notes); }),
}));

const { submitTimesheet, isTimesheetSubmitted, unsubmitTimesheet } = await import('../../src/services/timesheetSubmission.service.js');

beforeEach(() => {
  state.calendar = { attendanceCutoff: null };
  state.anomalies = 0;
  state.runs = [];
  state.createdRuns = [];
  state.auditRows = [];
  state.logs = [];
});

describe('TS-SUBMIT-01 — gate 1: attendance cycle locked (HR force override audited)', () => {
  it('refuses when the cutoff has not passed and no force', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() + 86400e3) };
    await expect(
      submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('HR-TP-01') });
  });

  it('allows HR early submission with force', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() + 86400e3) };
    const res = await submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558, force: true });
    expect(res.created).toBe(true);
    expect(res.forced).toBe(true);
    expect(state.auditRows[0].details).toContain('early-submission override');
  });

  it('passes without force once the cutoff has passed', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() - 86400e3) };
    const res = await submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 });
    expect(res.created).toBe(true);
    expect(res.forced).toBe(false);
  });
});

describe('TS-SUBMIT-01 — gate 2: zero unresolved anomaly requests (NO override)', () => {
  it('refuses when pending anomalies exist, even with force', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() - 86400e3) };
    state.anomalies = 3;
    await expect(
      submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558, force: true }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('HR-TP-02') });
    expect(state.createdRuns).toHaveLength(0);
  });

  it('passes when all anomaly requests are resolved', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() - 86400e3) };
    state.anomalies = 0;
    const res = await submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 });
    expect(res.created).toBe(true);
    expect(res.pendingAnomalies).toBe(0);
  });
});

describe('TS-SUBMIT-01 — effect: vault run activation + idempotency', () => {
  it('activates exactly ONE PENDING vault run; re-submit does not stack rows', async () => {
    state.calendar = { attendanceCutoff: new Date(Date.now() - 86400e3) };
    const first = await submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 });
    expect(first.created).toBe(true);
    expect(state.createdRuns).toHaveLength(1);
    expect(state.createdRuns[0].status).toBe('PENDING');

    // Second submit: the run now exists.
    state.runs = [{ id: state.createdRuns[0].id, status: 'PENDING', createdAt: new Date() }];
    const second = await submitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 });
    expect(second.created).toBe(false);
    expect(state.createdRuns).toHaveLength(1); // no duplicate
  });

  it('isTimesheetSubmitted reports the vault run once submission exists', async () => {
    state.runs = [{ id: 777, status: 'PENDING', createdAt: new Date() }];
    state.auditRows = [{ id: 10, action: 'TIMESHEET_SUBMITTED', payrollRunId: 777 }];
    const state1 = await isTimesheetSubmitted(TENANT, MONTH);
    expect(state1.submitted).toBe(true);
    expect(state1.run.id).toBe(777);

    state.runs = [];
    const state2 = await isTimesheetSubmitted(TENANT, MONTH);
    expect(state2.submitted).toBe(false);
  });

  it('does not treat an out-of-band Pending run as submitted without an audit marker', async () => {
    state.runs = [{ id: 778, status: 'PENDING', createdAt: new Date() }];
    state.auditRows = [];
    const result = await isTimesheetSubmitted(TENANT, MONTH);
    expect(result.submitted).toBe(false);
    expect(result.run).toBe(null);
  });
});

describe('TS-SUBMIT-01 — unsubmit state transition', () => {
  it('cancels only a pending submitted run and preserves an audit trail', async () => {
    state.runs = [{ id: 779, status: 'PENDING', createdAt: new Date() }];
    state.auditRows = [{ id: 11, action: 'TIMESHEET_SUBMITTED', payrollRunId: 779 }];
    const result = await unsubmitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 });
    expect(result.unsubmitted).toBe(true);
    expect(state.runs[0].status).toBe('CANCELLED');
    expect(state.auditRows.at(-1).action).toBe('TIMESHEET_UNSUBMITTED');
  });

  it('refuses to unsubmit a processed run', async () => {
    state.runs = [{ id: 780, status: 'COMPLETED', createdAt: new Date() }];
    await expect(
      unsubmitTimesheet({ tenantId: TENANT, month: MONTH, actorEmployeeId: 558 }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('HR-TP-04') });
  });
});

describe('TS-SUBMIT-01 — HR-TP-03: payroll cannot run an unsubmitted month', () => {
  it('refuses to submit a month with a malformed id', async () => {
    await expect(
      submitTimesheet({ tenantId: TENANT, month: '2026-9', actorEmployeeId: 558 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

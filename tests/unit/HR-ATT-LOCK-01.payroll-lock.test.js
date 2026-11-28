// HR-ATT-LOCK-01 / -02 — attendance in a payroll-covered period.
//  01: the DB trigger's PERIOD_PROTECTED reached the user as a bare 500.
//  02: manual time entries skipped the lock (HR added 8 h to a finalized October).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let run = null;
const tx = { $executeRaw: jest.fn(async () => 1), payrollRun: { findFirst: jest.fn(async () => run) } };
const prismaMock = {
  timeEntry: {
    create: jest.fn(async ({ data }) => ({ id: 1, ...data })),
    findFirst: jest.fn(async () => ({ id: 5, employeeId: 2, start_time: new Date('2026-10-15T09:00:00Z'), end_time: new Date('2026-10-15T17:00:00Z') })),
    update: jest.fn(async ({ data }) => ({ id: 5, ...data })),
    delete: jest.fn(async () => ({ id: 5 })),
  },
};
jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/rlsTenant.js', () => ({ tenantTransaction: jest.fn(async (_c, fn) => fn(tx)) }));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { normalizeError } = await import('../../src/middlewares/error.middleware.js');
const te = await import('../../src/services/timeEntryService.js');

beforeEach(() => { jest.clearAllMocks(); run = null; });

describe('HR-ATT-LOCK-01 PERIOD_PROTECTED is a 409 the user can act on', () => {
  it('maps the trigger error (no status) to HR-4090 with the instruction', () => {
    const err = Object.assign(new Error('PERIOD_PROTECTED: recall or cancel payroll before changing attendance'), { name: 'DriverAdapterError' });
    expect(normalizeError(err)).toMatchObject({ httpStatus: 409, code: 'HR-4090', message: expect.stringMatching(/^Recall or cancel the payroll run/) });
  });
  it('leaves other unknown errors a generic 500', () => {
    expect(normalizeError(new Error('boom')).httpStatus).toBe(500);
  });
});

describe('HR-ATT-LOCK-02 time entries respect the payroll lock', () => {
  const entry = { tenantId: 't1', employeeId: 2, start_time: '2026-10-15T09:00:00Z', end_time: '2026-10-15T17:00:00Z' };
  it('creates in an open period', async () => {
    await expect(te.createTimeEntry(entry)).resolves.toMatchObject({ id: 1 });
  });
  it('refuses create, update and delete inside a payroll run', async () => {
    run = { id: 2 };
    await expect(te.createTimeEntry(entry)).rejects.toMatchObject({ status: 409 });
    await expect(te.updateTimeEntry(5, { note: 'x' }, 2, 't1', true)).rejects.toMatchObject({ status: 409 });
    await expect(te.deleteTimeEntry(5, 2, 't1', true)).rejects.toMatchObject({ status: 409 });
    expect(prismaMock.timeEntry.create).not.toHaveBeenCalled();
    expect(prismaMock.timeEntry.update).not.toHaveBeenCalled();
    expect(prismaMock.timeEntry.delete).not.toHaveBeenCalled();
  });
});

describe('HR-ATT-LOCK-01 the MCP body status follows the mapping', () => {
  it('a status-less PERIOD_PROTECTED tool error reports 409, not 500', async () => {
    const { withToolError } = await import('../../src/mcp/utils/toolError.js');
    const res = await withToolError(async () => { throw new Error('PERIOD_PROTECTED: recall or cancel payroll before changing attendance'); }, 't')({});
    expect(JSON.parse(res.content[0].text)).toMatchObject({ status: 409, code: 'HR-4090' });
  });
});

// HR-ANOMALY-MONTH-01 (2026-10-06) — the anomaly approval inbox follows the
// Timesheet's month selector.
//
// hr_anomaly_list had no date arguments at all, so the screen sent `from`/`to`
// and the tool schema dropped them: switching months changed the attendance
// table but never the anomaly list, which kept showing every pending request
// the tenant had. The bound has to be the request's OWN DAY ("For date"), not
// the day it was filed on, or a request raised this month for an August day
// stays visible and one raised in August for a September day stays hidden.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const TENANT = '40314ef4-0a81-4390-b631-b3ad3f21f523';

const counts = { where: null };
const prismaMock = {
  attendanceAnomaly: {
    count: jest.fn(async ({ where }) => { counts.where = where; return 0; }),
    findMany: jest.fn(async ({ where }) => { counts.where = where; return []; }),
  },
  attendance: { findMany: jest.fn(async () => []) },
  employee: { findMany: jest.fn(async () => []) },
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/lib/tenancy.js', () => ({
  // Identity: the test reads the AND array the service built.
  scopedWhere: jest.fn((_tenantId, where) => where),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../src/services/attendanceAnomalyRouting.service.js', () => ({
  routeAnomaly: jest.fn(async () => ({ routed: true })),
  resolveApprovalChain: jest.fn(async () => []),
}));

const { listAnomalies } = await import('../../src/services/attendanceAnomaly.service.js');

const clauses = () => (counts.where?.AND ?? []);

// The date clause the service pushes for the month bounds.
const dateClause = () => clauses().find((c) => c && c.date)?.date;

beforeEach(() => {
  jest.clearAllMocks();
  counts.where = null;
});

describe('HR-ANOMALY-MONTH-01 month bounds', () => {
  it('bounds the request day to the selected month, inclusive of the last day', async () => {
    await listAnomalies({ tenantId: TENANT, from: '2026-09-01', to: '2026-09-30' });

    const date = dateClause();
    expect(date).toBeDefined();
    expect(date.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // The WHOLE of the 30th, so a request for 30 Sep is not filtered out by a
    // midnight-bound comparison.
    expect(date.lte.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('filters on the request day, never on createdAt', async () => {
    await listAnomalies({ tenantId: TENANT, from: '2026-09-01', to: '2026-09-30' });

    const withDate = clauses().filter((c) => c && (c.createdAt || c.created_at));
    expect(withDate).toHaveLength(0);
  });

  it('adds no date clause when no month is selected', async () => {
    await listAnomalies({ tenantId: TENANT, status: 'PENDING' });

    expect(dateClause()).toBeUndefined();
  });

  it('ignores a malformed bound rather than filtering everything away', async () => {
    await listAnomalies({ tenantId: TENANT, from: 'September', to: '' });

    expect(dateClause()).toBeUndefined();
  });

  it('accepts a single-day range', async () => {
    await listAnomalies({ tenantId: TENANT, from: '2026-10-05', to: '2026-10-05' });

    const date = dateClause();
    expect(date.gte.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(date.lte.toISOString()).toBe('2026-10-05T23:59:59.999Z');
  });
});
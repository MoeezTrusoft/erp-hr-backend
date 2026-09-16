// HR-ATT-PRIMARY-DEVICE-01 — primary-device resolution is period-scoped.
//
// An employee's primary biometric device is a property OF A PERIOD, not of the
// employee row: enrolments are effective-dated, so "which machine is primary"
// must be answered AS AT the day being marked. A machine that is primary today
// was not necessarily primary in August, and a re-enrolment must not
// retroactively rewrite history — the same rule enrolment resolution already
// follows for identity.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Yaseen (BOC 557): Johar enrolment until Aug 21, Dalmia from Aug 22. Both
// SN-scoped; the primary flag follows the current period.
const JOHAR = 'EUF7243800353';
const DALMIA = 'A8LN181960262';

const ENROLMENTS = [
  { id: 1, employeeId: 557, sn: JOHAR, effectiveFrom: new Date('2026-08-01'), effectiveTo: new Date('2026-08-21'), isPrimary: true },
  { id: 2, employeeId: 557, sn: DALMIA, effectiveFrom: new Date('2026-08-22'), effectiveTo: null, isPrimary: true },
  // Shah Hassan (555): SN-scoped primary (Johar 9014)…
  { id: 3, employeeId: 555, sn: JOHAR, effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isPrimary: true },
  // …and a null-sn catch-all for the other site — a null-`sn` matches every
  // machine and can never be a specific primary.
  { id: 4, employeeId: 555, sn: null, effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isPrimary: true },
  // No flag at all → no primary, even though the enrolment is in force.
  { id: 5, employeeId: 558, sn: DALMIA, effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isPrimary: false },
];

const prismaMock = {
  // The real query scopes by employeeId + isPrimary in the WHERE; the mock has
  // to honour that or rows belonging to other employees leak into resolution.
  employeeDeviceEnrolment: {
    findMany: jest.fn(async ({ where } = {}) =>
      ENROLMENTS.filter((r) =>
        (where?.employeeId == null || r.employeeId === where.employeeId)
        && (where?.isPrimary == null || r.isPrimary === where.isPrimary),
      )),
  },
};
const mcpCtxMock = { run: jest.fn(async (_ctx, fn) => fn()) };

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../src/mcp/context.js', () => ({ mcpCtx: mcpCtxMock }));

const { resolvePrimarySnAt } = await import('../../src/services/deviceEnrolment.service.js');

const at = (iso) => new Date(`${iso}T12:00:00.000Z`);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.employeeDeviceEnrolment.findMany.mockImplementation(async ({ where } = {}) =>
    ENROLMENTS.filter((r) =>
      (where?.employeeId == null || r.employeeId === where.employeeId)
      && (where?.isPrimary == null || r.isPrimary === where.isPrimary),
    ));
});

describe('HR-ATT-PRIMARY-DEVICE-01 resolvePrimarySnAt', () => {
  it('resolves the primary in force ON the day (period-scoped, not "flagged today")', async () => {
    // Aug 10: the Johar period is current — Dalmia is not yet in force.
    expect(await resolvePrimarySnAt(557, at('2026-08-10'))).toBe(JOHAR);
    // Aug 25: the Dalmia period is current.
    expect(await resolvePrimarySnAt(557, at('2026-08-25'))).toBe(DALMIA);
  });

  it('ignores a null-sn enrolment even when flagged primary', async () => {
    // A catch-all enrolment matches every device, so "the primary device"
    // would be undefined. Shah Hassan still resolves — via his SN-scoped row.
    expect(await resolvePrimarySnAt(555, at('2026-09-10'))).toBe(JOHAR);
  });

  it('returns null when no enrolment carries the primary flag', async () => {
    expect(await resolvePrimarySnAt(558, at('2026-09-10'))).toBeNull();
  });

  it('returns null before the primary period begins', async () => {
    expect(await resolvePrimarySnAt(557, at('2026-07-15'))).toBeNull();
  });

  it('prefers the NEWEST in-force period when primaries overlap (bad data)', async () => {
    const overlapping = [
      { id: 1, employeeId: 9, sn: 'OLD', effectiveFrom: new Date('2026-01-01'), effectiveTo: null, isPrimary: true },
      { id: 2, employeeId: 9, sn: 'NEW', effectiveFrom: new Date('2026-06-01'), effectiveTo: null, isPrimary: true },
    ];
    prismaMock.employeeDeviceEnrolment.findMany.mockResolvedValue(overlapping);
    expect(await resolvePrimarySnAt(9, at('2026-09-10'))).toBe('NEW');
  });
});

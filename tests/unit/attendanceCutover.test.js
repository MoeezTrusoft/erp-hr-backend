import { describe, it, expect } from '@jest/globals';
import { captureDb, TENANT } from '../helpers/captureDb.js';
import { applyEvaluatedShifts } from '../../src/services/attendanceWriter.service.js';

describe('activation across an overnight shift', () => {
  it('reconciles existing evidence without inventing a missing arrival or retaining next-day anomalies', async () => {
    const config = {
      version: 1,
      settings: { timeZone: 'Asia/Karachi', defaultCalendarId: 1, profiles: [], assignments: [] },
      policy: { checkoutLeniencyMin: 540, graceMinutes: 5 },
      employees: [1, 2].map(id => ({ id, payroll_included: true, hire_date: '2026-01-01' })),
      periods: [],
      schedules: [1, 2].map(employeeId => ({ employeeId, effective_start_date: '2026-01-01',
        schedule_pattern: { shift: { from: '20:00', to: '05:00' }, offDays: [] } })),
      calendars: [{ id: 1, year: 2026 }], holidays: [], calendarAssignments: [],
    };
    const db = captureDb({
      employee: [1, 2].map(id => ({ id, tenant_id: TENANT })),
      attendanceSetupRelease: [{ tenantId: TENANT, version: 1, effectiveFrom: new Date('2026-10-13'),
        coverageThrough: new Date('2026-12-31'), config }],
      attendanceDevicePunch: [
        { employeeId: 1, punchedAt: new Date('2026-10-12T19:58:00Z'), status: 0 },
        { employeeId: 1, punchedAt: new Date('2026-10-13T05:03:00Z'), status: 1 },
        { employeeId: 2, punchedAt: new Date('2026-10-13T05:05:00Z'), status: 1 },
      ].map((p, i) => ({ ...p, id: i + 1, tenantId: TENANT, sn: 'DEVICE-1', directionVerified: true })),
    });
    const evaluate = from => applyEvaluatedShifts({ tenantId: TENANT, from, to: '2026-10-13',
      employeeIds: [1, 2], now: new Date('2026-10-13T00:30:00Z'), db, dryRun: false });
    await evaluate('2026-10-13');
    // Until the prior work date is published these punches have no valid shift
    // window. Preserve them for review instead of attaching them to tonight.
    expect(db.snapshot().attendance.filter(r => r.status === 'PUNCH_CONFLICT')).toHaveLength(2);
    await db.attendanceSetupRelease.create({ data: { tenantId: TENANT, version: 2,
      effectiveFrom: new Date('2026-10-12'), coverageThrough: new Date('2026-10-12'), config: { ...config, version: 2 } } });
    await evaluate('2026-10-12');
    const rows = db.snapshot().attendance;
    const prior = id => rows.find(r => r.employeeId === id && r.date.toISOString().startsWith('2026-10-12'));
    expect(prior(1)).toMatchObject({ status: 'PRESENT', processingState: 'FINALIZED', day_credit: 1 });
    expect(prior(2)).toMatchObject({ status: 'MISSING_CHECKIN', processingState: 'NEEDS_REVIEW', check_in: null });
    expect(db.snapshot().attendanceAnomaly.filter(a => a.evidenceState === 'ACTIVE').map(a => a.type)).toEqual(['MISSING_CHECKIN']);
    const versions = rows.map(r => r.evaluationVersion);
    await evaluate('2026-10-12');
    expect(db.snapshot().attendance.map(r => r.evaluationVersion)).toEqual(versions);
    expect(db.snapshot().attendanceManualTime).toHaveLength(0);
  });
});
